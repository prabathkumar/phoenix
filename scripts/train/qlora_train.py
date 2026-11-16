#!/usr/bin/env python3
"""QLoRA fine-tune of Qwen3-8B on the exported Phoenix dataset, then score it against the live model on the held-out set and report to the API.
Run on a GPU box (T4 16 GB works in 4-bit but is slow; an A10G/L4/A100 is much faster):
  pip install "transformers>=4.51" peft trl bitsandbytes datasets accelerate
  python3 scripts/train/qlora_train.py --data <dataset dir> --out <dir> --job <id> --report <api url>
The API's gate decides whether the result may be promoted; this script never changes the live model.
Score = share of held-out prompts whose answer matches the logged good answer (normalised exact match for short answers, JSON-equal for JSON, token-F1 >= 0.8 otherwise);
valid = share of answers that are non-empty and (when the reference is JSON) parse as JSON."""
import argparse
import json
import os
import re
import sys
import urllib.request


def load(path):
    return [json.loads(x) for x in open(path, encoding="utf8") if x.strip()] if os.path.exists(path) else []


def norm(t):
    return re.sub(r"\s+", " ", re.sub(r"<think>.*?</think>", "", str(t), flags=re.S)).strip().lower()


def as_json(t):
    try:
        return json.loads(re.search(r"\{.*\}|\[.*\]", str(t), re.S).group(0))
    except Exception:  # noqa: BLE001
        return None


def f1(a, b):
    a, b = norm(a).split(), norm(b).split()
    if not a or not b:
        return 0.0
    common = sum(min(a.count(w), b.count(w)) for w in set(a))
    if not common:
        return 0.0
    p, r = common / len(a), common / len(b)
    return 2 * p * r / (p + r)


def matches(answer, ref):
    ja, jr = as_json(ref), None
    if ja is not None:
        jr = as_json(answer)
        return jr == ja
    return norm(answer) == norm(ref) or f1(answer, ref) >= 0.8


def score(generate, items):
    ok = valid = 0
    for it in items:
        ref = it["messages"][1]["content"]
        ans = generate(it["messages"][0]["content"])
        ok += matches(ans, ref)
        valid += bool(norm(ans)) and (as_json(ref) is None or as_json(ans) is not None)
    n = max(1, len(items))
    return ok / n, valid / n


def report(url, token, body):
    req = urllib.request.Request(url, data=json.dumps(body).encode(), headers={"content-type": "application/json", **({"x-ingest-token": token} if token else {})}, method="POST")
    try:
        urllib.request.urlopen(req, timeout=30).read()
    except Exception as e:  # noqa: BLE001 - training goes on even if the API is unreachable; results are also written to disk
        print("could not report:", e, file=sys.stderr)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--data", required=True); ap.add_argument("--out", required=True); ap.add_argument("--job", required=True); ap.add_argument("--report", required=True)
    ap.add_argument("--base", default="Qwen/Qwen3-8B"); ap.add_argument("--epochs", type=float, default=2); ap.add_argument("--lr", type=float, default=2e-4)
    ap.add_argument("--max-len", type=int, default=1536); ap.add_argument("--live-url", default=os.environ.get("PHOENIX_AGENT_LLM_URL", ""))
    a = ap.parse_args()
    token = os.environ.get("PHOENIX_INGEST_TOKEN", "")
    train, ev = load(os.path.join(a.data, "train.jsonl")), load(os.path.join(a.data, "eval.jsonl"))
    if not train or not ev:
        report(a.report, token, {"status": "failed", "error": "dataset has no train or eval examples"}); sys.exit(1)
    report(a.report, token, {"status": "running", "progress": 0})
    try:
        import torch
        from datasets import Dataset
        from peft import LoraConfig
        from transformers import AutoModelForCausalLM, AutoTokenizer, BitsAndBytesConfig, TrainerCallback
        from trl import SFTConfig, SFTTrainer
        tok = AutoTokenizer.from_pretrained(a.base)
        model = AutoModelForCausalLM.from_pretrained(a.base, device_map="auto", quantization_config=BitsAndBytesConfig(load_in_4bit=True, bnb_4bit_quant_type="nf4", bnb_4bit_compute_dtype=torch.float16, bnb_4bit_use_double_quant=True))

        class Progress(TrainerCallback):
            def on_log(self, args, state, control, logs=None, **kw):
                if logs and "loss" in logs and state.max_steps:
                    report(a.report, token, {"status": "running", "progress": round(state.global_step / state.max_steps, 3), "loss": round(float(logs["loss"]), 4)})

        cfg = SFTConfig(output_dir=os.path.join(a.out, "run"), num_train_epochs=a.epochs, learning_rate=a.lr, per_device_train_batch_size=1, gradient_accumulation_steps=8, max_length=a.max_len,
                        logging_steps=5, save_strategy="no", fp16=True, gradient_checkpointing=True, report_to=[], optim="paged_adamw_8bit")
        peft = LoraConfig(r=16, lora_alpha=32, lora_dropout=0.05, task_type="CAUSAL_LM", target_modules=["q_proj", "k_proj", "v_proj", "o_proj", "gate_proj", "up_proj", "down_proj"])
        tr = SFTTrainer(model=model, args=cfg, train_dataset=Dataset.from_list([{"messages": x["messages"]} for x in train]), processing_class=tok, peft_config=peft, callbacks=[Progress()])
        tr.train()
        tr.model.save_pretrained(os.path.join(a.out, "adapter")); tok.save_pretrained(os.path.join(a.out, "adapter"))
        report(a.report, token, {"status": "evaluating", "progress": 1})

        def tuned(prompt):
            ids = tok.apply_chat_template([{"role": "user", "content": prompt + " /no_think"}], add_generation_prompt=True, return_tensors="pt").to(tr.model.device)
            out = tr.model.generate(ids, max_new_tokens=200, do_sample=False)
            return tok.decode(out[0][ids.shape[1]:], skip_special_tokens=True)

        def live(prompt):
            if not a.live_url:
                return ""
            body = json.dumps({"model": os.environ.get("PHOENIX_AGENT_MODEL", "qwen3-8b"), "temperature": 0, "max_tokens": 200, "messages": [{"role": "user", "content": prompt + " /no_think"}]}).encode()
            h = {"content-type": "application/json", **({"authorization": "Bearer " + os.environ["PHOENIX_AGENT_LLM_KEY"]} if os.environ.get("PHOENIX_AGENT_LLM_KEY") else {})}
            try:
                return json.load(urllib.request.urlopen(urllib.request.Request(a.live_url.rstrip("/") + "/v1/chat/completions", body, h), timeout=120))["choices"][0]["message"]["content"]
            except Exception:  # noqa: BLE001
                return ""

        ts, tv = score(tuned, ev)
        ls, _ = score(live, ev)
        metrics = {"tuned_score": round(ts, 4), "live_score": round(ls, 4), "tuned_valid": round(tv, 4), "eval_examples": len(ev), "train_examples": len(train), "live_measured": bool(a.live_url)}
        json.dump(metrics, open(os.path.join(a.out, "metrics.json"), "w"))
        report(a.report, token, {"status": "finished", "metrics": metrics})
    except Exception as e:  # noqa: BLE001
        report(a.report, token, {"status": "failed", "error": f"{type(e).__name__}: {e}"}); raise


if __name__ == "__main__":
    main()
