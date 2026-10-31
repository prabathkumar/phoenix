import { useState } from "react";
import { Link } from "react-router-dom";
import { api, post } from "../api.js";
import { startRun } from "../run.js";
import { Btn, Card, Chip, ErrorNote, StatusChip, useLoad } from "../ui.jsx";

/** Runs chosen stages once, shows what each did. Approval-gated stages come back as 'Needs you' with an approve button. */
function useStageRun(stages, extra) {
  const [out, setOut] = useState(null);
  const [err, setErr] = useState(null);
  const [busy, setBusy] = useState(false);
  async function run(approvals = {}) {
    setBusy(true); setErr(null);
    try { setOut(await startRun({ goal: extra.goal, ...extra.body(), stages, approvals })); } catch (e) { setErr(e); } finally { setBusy(false); }
  }
  return { out, err, busy, run };
}
function Result({ out, err, busy, run, only }) {
  return (
    <>
      <ErrorNote error={err} />
      {out ? <Card>
        <div className="row"><b>Result</b><Link to={`/runs/${out.runId}`} className="sub">{out.runId}</Link></div>
        {out.stages.filter((s) => (only ? only.includes(s.id) : s.status !== "skipped")).map((s) => (
          <div className="stage" key={s.id}><StatusChip status={s.status} /><div className="grow"><b>{s.name || s.id}</b><div className="sub">{s.detail}</div>{s.ai ? <div className="sub">AI: {s.ai}</div> : null}</div>
            {s.status === "needs-you" ? <Btn pri disabled={busy} onClick={() => run({ ...Object.fromEntries(out.needsYou.map((i) => [i, i === s.id])) })}>Approve and run</Btn> : null}</div>
        ))}
      </Card> : null}
    </>
  );
}

export function Performance() {
  const [f, setF] = useState({ baseUrl: "", users: 10 });
  const r = useStageRun(["performance"], { goal: "Load test", body: () => ({ baseUrl: f.baseUrl, steps: [{ kind: "api", method: "GET", url: "/" }] }) });
  return (
    <div className="page narrow">
      <div><div className="sub">Stage 6 of 8</div><h1>Performance</h1></div>
      <Card hi><b>Script ready</b><div className="sub">The AI writes the Locust script from the HAR the web run recorded, or from your API steps.</div>
        <b>Pass or fail rules, suggested by the AI</b><div className="row"><Chip>Average response time under 500 ms</Chip><Chip>Failed requests under 1%</Chip></div>
        <label htmlFor="pu">Runs against</label><input id="pu" value={f.baseUrl} onChange={(e) => setF({ ...f, baseUrl: e.target.value })} placeholder="https://test.example.com" />
        <div className="note">Only run load against a test environment, never production.</div>
        <div className="row"><span className="grow" /><Btn pri disabled={!f.baseUrl || r.busy} onClick={() => r.run()}>Run load test</Btn></div></Card>
      <Result {...r} />
    </div>
  );
}

export function Security() {
  const [f, setF] = useState({ appUrl: "", repo: "", provider: "github", ajax: false });
  const dast = useStageRun(["dast"], { goal: "DAST scan", body: () => ({ appUrl: f.appUrl }) });
  const sast = useStageRun(["secrets", "sast"], { goal: "SAST and secrets scan", body: () => ({}) });
  return (
    <div className="page narrow">
      <div><div className="sub">Stage 7 of 8</div><h1>Security</h1></div>
      <Card><div className="row"><h2 className="grow">SAST · Scan the code</h2><Chip kind="ok">Safe: nothing is run or changed</Chip></div>
        <div className="sub">Semgrep reads the source for weak spots; Gitleaks looks for secrets. Both scan the code on the server's working folder.</div>
        <div className="row"><span className="grow" /><Btn disabled={sast.busy} onClick={() => sast.run()}>Scan the code</Btn></div></Card>
      <Result {...sast} />
      <Card hi><div className="row"><h2 className="grow">DAST · Scan the running app</h2><Chip kind="warn">Needs your approval: it sends attack traffic</Chip></div>
        <label htmlFor="su">Target</label><input id="su" value={f.appUrl} onChange={(e) => setF({ ...f, appUrl: e.target.value })} placeholder="https://test.example.com" />
        <div className="sub">Only scan apps and code your company owns. Each finding that needs action becomes a defect in the next stage.</div>
        <div className="row"><span className="grow" /><Btn pri disabled={!f.appUrl || dast.busy} onClick={() => dast.run()}>Approve and scan</Btn></div></Card>
      <Result {...dast} />
    </div>
  );
}

export function Defects() {
  const runs = useLoad(() => api.runs());
  const failed = (runs.data ? runs.data.runs : []).filter((r) => r.execution === "failed");
  const [res, setRes] = useState(null);
  const [err, setErr] = useState(null);
  async function log(id) { setErr(null); try { setRes(await startRun({ goal: "Log defects", stages: ["defects"], approvals: { defects: true } })); } catch (e) { setErr(e); } }
  return (
    <div className="page narrow">
      <div><div className="sub">Stage 8 of 8</div><h1>Defects</h1></div>
      <Card hi><div className="sub">Jira is linked on the server. The AI drafts a defect for every failure, checks for an open one with the same label first so nothing is logged twice, and links it to the test case and requirement. Defects are logged only when you approve.</div>
        <b>Runs with failures</b>
        {failed.map((r) => <div className="row" key={r.id}><div className="grow"><Link to={`/runs/${r.id}`}>{r.id}</Link><div className="sub">{r.goal}</div></div><Link className="btn" to={`/runs/${r.id}`}>Open</Link></div>)}
        {runs.data && !failed.length ? <div className="sub">No failed runs.</div> : null}
        <ErrorNote error={err || runs.error} /></Card>
      {res ? <Result out={res} run={() => {}} busy={false} only={["defects"]} /> : null}
      <div className="sub"><Btn onClick={log}>Log pending defects in Jira (approve)</Btn></div>
    </div>
  );
}

export function CodeAnalyzer() {
  const [f, setF] = useState({ provider: "github", project: "", requirement: "" });
  const r = useStageRun(["sast", "secrets", "traceability", "unittests"], { goal: "Analyse the code", body: () => ({ requirement: f.requirement, repo: { provider: f.provider, project: f.project } }) });
  const pr = useStageRun(["sast", "unittests", "testspr"], { goal: "Unit tests as a pull request", body: () => ({ repo: { provider: f.provider, project: f.project } }) });
  return (
    <div className="page narrow">
      <div><h1>Code Analyzer</h1><div className="sub">Scans the code, checks the requirements against what is built, and writes unit tests in six languages (JavaScript, TypeScript, Python, Java, Go, C#).</div></div>
      <Card hi>
        <div className="grid"><div><label htmlFor="cp">Host</label><select id="cp" value={f.provider} onChange={(e) => setF({ ...f, provider: e.target.value })}><option value="github">GitHub</option><option value="gitlab">GitLab</option></select></div>
          <div><label htmlFor="cr">Repository</label><input id="cr" value={f.project} onChange={(e) => setF({ ...f, project: e.target.value })} placeholder="owner/name" /></div></div>
        <label htmlFor="cq">Requirement to check against what is built</label><textarea id="cq" value={f.requirement} onChange={(e) => setF({ ...f, requirement: e.target.value })} />
        <div className="row"><span className="grow" /><Btn disabled={!f.project || r.busy} onClick={() => r.run()}>Analyse</Btn><Btn pri disabled={!f.project || pr.busy} onClick={() => pr.run()}>Write tests and open a pull request</Btn></div>
        <div className="sub">The pull request is only opened after you approve it. The generated tests are not run here: your CI runs them on the branch.</div>
      </Card>
      <Result {...r} /><Result {...pr} />
    </div>
  );
}

export function AiEval() {
  const [f, setF] = useState({ conversation: "", metrics: { answer_relevancy: true, toxicity: true, bias: true, faithfulness: false, hallucination: false, contextual_relevancy: false, geval: false }, criteria: "", threshold: 0.5 });
  const [out, setOut] = useState(null);
  const [err, setErr] = useState(null);
  const [busy, setBusy] = useState(false);
  async function go() {
    setBusy(true); setErr(null);
    try { setOut(await post("/api/eval/run", { conversation: f.conversation, metrics: Object.keys(f.metrics).filter((m) => f.metrics[m]), criteria: f.criteria, threshold: Number(f.threshold) })); } catch (e) { setErr(e); } finally { setBusy(false); }
  }
  return (
    <div className="page narrow">
      <div><h1>AI Evaluation</h1><div className="sub">Is the chatbot's answer good? Paste a conversation and pick what to check. Scored by DeepEval; secrets and personal data are removed before anything is sent to the judge.</div></div>
      <Card hi>
        <label htmlFor="conv">Conversation (lines starting User: and Bot:)</label>
        <textarea id="conv" value={f.conversation} onChange={(e) => setF({ ...f, conversation: e.target.value })} style={{ minHeight: 140 }} />
        <div className="row">{Object.keys(f.metrics).map((m) => <label key={m} className="row" style={{ fontWeight: 400, gap: 6 }}><input type="checkbox" style={{ width: "auto" }} checked={f.metrics[m]} onChange={(e) => setF({ ...f, metrics: { ...f.metrics, [m]: e.target.checked } })} />{m.replace(/_/g, " ")}</label>)}</div>
        {f.metrics.geval ? <><label htmlFor="crit">Your criteria in words</label><input id="crit" value={f.criteria} onChange={(e) => setF({ ...f, criteria: e.target.value })} /></> : null}
        <ErrorNote error={err} />
        <div className="row"><span className="grow" /><Btn pri disabled={busy || !f.conversation.trim()} onClick={go}>Evaluate</Btn></div>
      </Card>
      {out && out.status !== "ok" ? <div className={out.status === "error" ? "err" : "note"}>{out.why}</div> : null}
      {out && out.status === "ok" ? <Card><b>{out.summary.passed} of {out.summary.scored} checks passed</b>
        <table><thead><tr><th>Turn</th><th>Metric</th><th>Score</th><th>Result</th></tr></thead><tbody>{out.results.map((r, i) => <tr key={i}><td>{r.turn + 1}</td><td>{r.metric}{r.reason ? <div className="sub">{r.reason}</div> : null}{r.skipped ? <div className="sub">skipped: {r.skipped}</div> : null}</td><td>{typeof r.score === "number" ? r.score.toFixed(2) : "–"}</td><td>{typeof r.score === "number" ? <Chip kind={r.passed ? "ok" : "bad"}>{r.passed ? "Pass" : "Fail"}</Chip> : <Chip>Skipped</Chip>}</td></tr>)}</tbody></table></Card> : null}
    </div>
  );
}
