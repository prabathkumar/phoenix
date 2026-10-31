#!/usr/bin/env python3
"""
Runs DeepEval metrics over conversation turns.   python3 scripts/deepeval_run.py in.json out.json

in.json : {"turns":[{"input","actual_output","expected_output"?,"context"?[],"retrieval_context"?[]}],
           "metrics":["answer_relevancy","faithfulness","hallucination","toxicity","bias","contextual_relevancy","geval"],
           "threshold":0.5, "criteria":"... (for geval)"}
out.json: {"results":[{"turn":0,"metric":"...","score":0.8,"passed":true,"reason":"..."|"skipped":"why"}]}

The judge model is a self-hosted Ollama model (DEEPEVAL_OLLAMA_MODEL, DEEPEVAL_OLLAMA_URL) or, when
OPENAI_API_KEY is set, DeepEval's default. With neither, it exits with code 3 and says so; nothing is sent anywhere.
"""
import json
import os
import sys
import warnings

warnings.filterwarnings("ignore")

# metric -> (class name, test-case fields it needs)
NEEDS = {
    "answer_relevancy": ("AnswerRelevancyMetric", []),
    "faithfulness": ("FaithfulnessMetric", ["retrieval_context"]),
    "hallucination": ("HallucinationMetric", ["context"]),
    "toxicity": ("ToxicityMetric", []),
    "bias": ("BiasMetric", []),
    "contextual_relevancy": ("ContextualRelevancyMetric", ["retrieval_context"]),
    "geval": ("GEval", []),
}


def judge_model():
    if os.environ.get("DEEPEVAL_OLLAMA_MODEL"):
        from deepeval.models import OllamaModel
        return OllamaModel(model=os.environ["DEEPEVAL_OLLAMA_MODEL"], base_url=os.environ.get("DEEPEVAL_OLLAMA_URL") or None)
    if os.environ.get("OPENAI_API_KEY"):
        return None  # DeepEval's default judge
    return False


def run(spec):
    from deepeval import metrics as M
    from deepeval.test_case import LLMTestCase
    try:
        from deepeval.test_case import SingleTurnParams as P
    except ImportError:  # older DeepEval
        from deepeval.test_case import LLMTestCaseParams as P

    model = judge_model()
    if model is False:
        print("No judge model: set DEEPEVAL_OLLAMA_MODEL (and DEEPEVAL_OLLAMA_URL) or OPENAI_API_KEY.", file=sys.stderr)
        sys.exit(3)
    threshold = float(spec.get("threshold", 0.5))
    results = []
    for i, turn in enumerate(spec.get("turns", [])):
        case = LLMTestCase(
            input=turn.get("input", ""),
            actual_output=turn.get("actual_output", ""),
            expected_output=turn.get("expected_output"),
            context=turn.get("context"),
            retrieval_context=turn.get("retrieval_context"),
        )
        for name in spec.get("metrics", []):
            if name not in NEEDS:
                results.append({"turn": i, "metric": name, "skipped": "unknown metric"})
                continue
            cls, needs = NEEDS[name]
            missing = [f for f in needs if not turn.get(f)]
            if missing:
                results.append({"turn": i, "metric": name, "skipped": "needs " + ", ".join(missing)})
                continue
            try:
                if name == "geval":
                    if not spec.get("criteria"):
                        results.append({"turn": i, "metric": name, "skipped": "needs criteria"})
                        continue
                    metric = M.GEval(name="Criteria", criteria=spec["criteria"], evaluation_params=[P.INPUT, P.ACTUAL_OUTPUT], threshold=threshold, model=model)
                elif name in ("toxicity", "bias"):
                    # these two score harm: lower is better, so DeepEval's threshold is a maximum
                    metric = getattr(M, cls)(threshold=threshold, model=model, include_reason=True)
                else:
                    metric = getattr(M, cls)(threshold=threshold, model=model, include_reason=True)
                metric.measure(case)
                results.append({"turn": i, "metric": name, "score": float(metric.score), "passed": bool(metric.is_successful()), "reason": str(getattr(metric, "reason", "") or "")[:400]})
            except Exception as e:  # one failing metric must not lose the rest
                results.append({"turn": i, "metric": name, "skipped": "error: " + str(e)[:200]})
    return {"results": results}


if __name__ == "__main__":
    spec = json.load(open(sys.argv[1]))
    out = run(spec)
    json.dump(out, open(sys.argv[2], "w"))
