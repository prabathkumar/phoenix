const assert = require("assert");
const fs = require("fs"), os = require("os"), path = require("path");
const E = require("../core/ai-eval");

// A stand-in "deepeval" package so the real scripts/deepeval_run.py runs offline, with scores we control.
const stub = fs.mkdtempSync(path.join(os.tmpdir(), "stub-"));
fs.mkdirSync(path.join(stub, "deepeval"));
fs.writeFileSync(path.join(stub, "deepeval", "__init__.py"), "");
fs.writeFileSync(path.join(stub, "deepeval", "test_case.py"), `
import json, os
class SingleTurnParams:
    INPUT = "input"; ACTUAL_OUTPUT = "actual_output"
class LLMTestCase:
    def __init__(self, **kw):
        self.__dict__.update(kw)
        with open(os.environ["STUB_LOG"], "a") as f: f.write(json.dumps(kw) + "\\n")
`);
fs.writeFileSync(path.join(stub, "deepeval", "models.py"), "class OllamaModel:\n    def __init__(self, model=None, base_url=None):\n        self.model = model; self.base_url = base_url\n");
fs.writeFileSync(path.join(stub, "deepeval", "metrics.py"), `
class _M:
    def __init__(self, threshold=0.5, model=None, include_reason=True, **kw):
        self.threshold = threshold; self.model = model; self.reason = ""
    def measure(self, case):
        self.score = self.value(case); self.reason = "stub"
    def is_successful(self):
        return self.score >= self.threshold
class AnswerRelevancyMetric(_M):
    def value(self, c): return 0.2 if "banana" in c.actual_output else 0.9
class FaithfulnessMetric(_M):
    def value(self, c): return 0.95
class HallucinationMetric(_M):
    def value(self, c): return 0.9
class ToxicityMetric(_M):
    def value(self, c): return 0.1
    def is_successful(self): return self.score <= self.threshold
class BiasMetric(_M):
    def value(self, c): return 0.1
    def is_successful(self): return self.score <= self.threshold
class ContextualRelevancyMetric(_M):
    def value(self, c): return 0.8
class GEval(_M):
    def __init__(self, name=None, criteria=None, evaluation_params=None, **kw):
        super().__init__(**kw); self.criteria = criteria
    def value(self, c): return 0.7 if "refund" in self.criteria else 0.1
`);
const log = path.join(stub, "log.jsonl");
const env = { PYTHONPATH: stub, STUB_LOG: log, DEEPEVAL_OLLAMA_MODEL: "llama3", PATH: process.env.PATH };

(async () => {
// conversation parsing
const turns = E.parseConversation("User: How do I reset my password?\nBot: Click Forgot password.\nThen follow the email.\n\nCustomer: Refund?\nAssistant: Refunds take 5 days. banana");
assert.deepStrictEqual(turns.map((t) => t.input), ["How do I reset my password?", "Refund?"]);
assert.ok(turns[0].actual_output.includes("Then follow the email."));
assert.deepStrictEqual(E.parseConversation("no markers here"), []);

// validation, before anything runs
assert.match(E.evaluate({ conversation: "x", env }).why, /No conversation/);
assert.match(E.evaluate({ turns, metrics: ["nope"], env }).why, /at least one metric/);
assert.match(E.evaluate({ turns, metrics: ["geval"], env }).why, /criteria/);
assert.match(E.evaluate({ turns, threshold: 3, env }).why, /between 0 and 1/);

// not available: no python module, or no judge
assert.strictEqual(E.evaluate({ turns, env: { PATH: process.env.PATH, PYTHONPATH: "" }, exec: (c, a) => (a[0] === "-c" ? { status: 1 } : { status: 0 }) }).status, "unavailable");
const nojudge = E.evaluate({ turns, env: { PATH: process.env.PATH, PYTHONPATH: stub, STUB_LOG: log } });
assert.strictEqual(nojudge.status, "unavailable"); assert.match(nojudge.why, /judge model/);

// a real run of scripts/deepeval_run.py against the stub: scores, pass/fail, skips with reasons
const r = E.evaluate({ turns: [{ input: "Refund?", actual_output: "Refunds take 5 days. banana", retrieval_context: ["policy"] }, { input: "Hi", actual_output: "Hello" }], metrics: ["answer_relevancy", "toxicity", "faithfulness", "hallucination", "geval"], criteria: "The answer follows the refund policy", env });
assert.strictEqual(r.status, "ok", JSON.stringify(r));
const get = (turn, m) => r.results.find((x) => x.turn === turn && x.metric === m);
assert.strictEqual(get(0, "answer_relevancy").passed, false);          // banana answer scores low
assert.strictEqual(get(1, "answer_relevancy").passed, true);
assert.strictEqual(get(0, "faithfulness").passed, true);
assert.match(get(1, "faithfulness").skipped, /needs retrieval_context/);   // no context given: skipped, not faked
assert.match(get(0, "hallucination").skipped, /needs context/);
assert.strictEqual(get(0, "geval").passed, true);
assert.strictEqual(r.summary.failed, 1); assert.strictEqual(r.summary.byMetric.answer_relevancy.n, 2);
assert.strictEqual(r.summary.byMetric.answer_relevancy.avg, 0.55);

// secrets and personal data never reach the judge
E.evaluate({ turns: [{ input: "My email is jo@x.com and key sk-abcdef1234567890abcd", actual_output: "Thanks, card 4111 1111 1111 1111" }], metrics: ["toxicity"], env });
const sent = fs.readFileSync(log, "utf8");
assert.ok(!/jo@x\.com|sk-abc|4111/.test(sent), sent);

// the handler: unavailable reasons come through plainly
const { aievalHandler } = require("../core/handlers");
assert.strictEqual((await aievalHandler({ evaluate: () => ({ status: "unavailable", why: "x" }) })({ evaluate: { conversation: "User: a\nBot: b" } })).unavailable, true);
assert.strictEqual((await aievalHandler({})({})).unavailable, true);
const hv = await aievalHandler({ evaluate: (o) => E.evaluate({ ...o, env }) })({ evaluate: { turns, metrics: ["answer_relevancy"] } });
assert.strictEqual(hv.ok, false); assert.match(hv.detail, /1 of 2 checks passed/);
console.log("ai-eval tests passed");
})().catch((e) => { console.error(e); process.exit(1); });
