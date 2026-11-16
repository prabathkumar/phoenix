import { useState } from "react";
import { api } from "../api.js";
import { Btn, Card, Chip, ErrorNote, useLoad } from "../ui.jsx";

export default function UnitTests() {
  const conn = useLoad(() => api.unitConnectors());
  const [f, setF] = useState({ project: "", provider: "github", repo: "", base: "", head: "", requirementKey: "", requirement: "", languages: [], openPr: false, dir: "", cloneUrl: "" });
  const [gen, setGen] = useState(null), [run, setRun] = useState(null), [err, setErr] = useState(null), [busy, setBusy] = useState("");
  const set = (k) => (e) => setF({ ...f, [k]: e.target.type === "checkbox" ? e.target.checked : e.target.value });
  const toggle = (l) => setF({ ...f, languages: f.languages.includes(l) ? f.languages.filter((x) => x !== l) : [...f.languages, l] });
  const langs = conn.data ? Object.entries(conn.data.languages) : [];
  async function generate() { setErr(null); setBusy("gen"); try { setGen(await api.unitGenerate({ project: f.project, requirementKey: f.requirementKey, requirement: f.requirement, openPr: f.openPr, repo: { provider: f.provider, project: f.repo, base: f.base || undefined, head: f.head || undefined, languages: f.languages.length ? f.languages : undefined } })); } catch (e) { setErr(e); } setBusy(""); }
  async function runTests() { setErr(null); setBusy("run"); try { setRun(await api.unitRun({ project: f.project, repo: { dir: f.dir || undefined, cloneUrl: f.cloneUrl || undefined, languages: f.languages.length ? f.languages : undefined } })); } catch (e) { setErr(e); } setBusy(""); }
  return (
    <div className="page">
      <div><h1>Unit and integration tests</h1><div className="sub">For developers. The AI writes unit tests from a requirement and the code that changed; the same page runs unit and integration tests with each language's own toolchain, as many times as you like. Every test that carries the requirement key is linked to that requirement.</div></div>
      <ErrorNote error={err} />
      <Card><b>Language</b><div className="sub">Leave all unselected to detect from the repo. A toolchain that is not installed on the server is marked, never counted as a pass.</div>
        <div className="row" style={{ flexWrap: "wrap" }}>{langs.map(([l, v]) => <button key={l} title={v.convention} className={`chip ${f.languages.includes(l) ? "info" : "mut"}`} onClick={() => toggle(l)}>{l}{v.available ? "" : " (toolchain missing)"}</button>)}</div></Card>
      <Card><b>1. Write tests for a requirement and the changed code</b>
        <div className="grid" style={{ gridTemplateColumns: "repeat(auto-fit,minmax(200px,1fr))" }}>
          <input placeholder="project id" value={f.project} onChange={set("project")} />
          <select value={f.provider} onChange={set("provider")}><option>github</option><option>gitlab</option></select>
          <input placeholder="owner/name" value={f.repo} onChange={set("repo")} />
          <input placeholder="base (branch or commit)" value={f.base} onChange={set("base")} />
          <input placeholder="head (branch or commit)" value={f.head} onChange={set("head")} />
          <input placeholder="requirement key, e.g. PROJ-123" value={f.requirementKey} onChange={set("requirementKey")} /></div>
        <textarea placeholder="The requirement in words (what the code must do)" value={f.requirement} onChange={set("requirement")} rows={3} style={{ width: "100%" }} />
        <div className="row"><label><input type="checkbox" checked={f.openPr} onChange={set("openPr")} /> open a pull request with the tests (never merged by the AI)</label><Btn pri onClick={generate} disabled={busy === "gen" || !f.repo}>{busy === "gen" ? "Writing…" : "Write tests"}</Btn></div>
        {gen ? <div style={{ marginTop: 8 }}><Chip kind={gen.ok ? "ok" : "warn"}>{gen.unavailable ? "unavailable" : gen.ok ? "written" : "nothing written"}</Chip> <span className="sub">{gen.detail}</span>
          {gen.pr && gen.pr.detail ? <div className="sub">Pull request: {gen.pr.detail}</div> : null}
          {(gen.data ? gen.data.tests : []).map((t) => <details key={t.path}><summary>{t.path} <Chip kind="mut">{t.language}</Chip>{t.changed ? <Chip kind="info">covers changed lines</Chip> : null}</summary><pre style={{ overflow: "auto" }}>{t.content}</pre></details>)}
          {(gen.data ? gen.data.skipped : []).map((s) => <div key={s.source} className="sub">skipped {s.source}: {s.why}</div>)}</div> : null}</Card>
      <Card><b>2. Run unit and integration tests</b>
        <div className="grid" style={{ gridTemplateColumns: "repeat(auto-fit,minmax(260px,1fr))" }}>
          <input placeholder="checkout folder on the server" value={f.dir} onChange={set("dir")} />
          <input placeholder="or https clone URL" value={f.cloneUrl} onChange={set("cloneUrl")} /></div>
        <div className="row"><Btn pri onClick={runTests} disabled={busy === "run" || !(f.dir || f.cloneUrl)}>{busy === "run" ? "Running…" : "Run tests"}</Btn><span className="sub">Each click is a new run; results build up per requirement on the Quality page.</span></div>
        {run ? <div style={{ marginTop: 8 }}><Chip kind={run.ok ? "ok" : run.unavailable ? "warn" : "bad"}>{run.ok ? "passed" : run.unavailable ? "not run" : "failed"}</Chip> <span className="sub">{run.detail} · run {run.run}</span>
          <table><thead><tr><th>Language</th><th>Kind</th><th>Result</th><th>Passed</th><th>Failed</th><th>Requirements</th></tr></thead><tbody>
            {(run.data ? run.data.runs : []).map((x, i) => <tr key={i}><td>{x.language}</td><td>{x.kind}</td><td className="sub">{x.detail}</td><td>{x.summary.passed}</td><td>{x.summary.failed}</td><td className="sub">{x.summary.requirements.join(", ")}</td></tr>)}</tbody></table></div> : null}</Card>
    </div>
  );
}
