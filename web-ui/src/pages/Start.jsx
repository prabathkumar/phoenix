import { useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { Btn, Card, Chip, ErrorNote } from "../ui.jsx";
import { startRun } from "../run.js";

const toB64 = (f) => new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(String(r.result).split(",")[1] || ""); r.onerror = rej; r.readAsDataURL(f); });
const SOURCES = ["Jira link", "Azure DevOps", "SharePoint link", "Public web page", "PDF, Word, Excel, PowerPoint", "Markdown, CSV, JSON, OpenAPI"];

export default function Start() {
  const nav = useNavigate();
  const [params] = useSearchParams();
  const [f, setF] = useState({ project: "", jiraKey: "", url: "", text: "", appUrl: "", provider: "github", repo: "", testData: "" });
  const [file, setFile] = useState(null);
  const [err, setErr] = useState(null);
  const [busy, setBusy] = useState(false);
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });

  async function go() {
    setBusy(true); setErr(null);
    try {
      const body = { goal: params.get("retest") ? `Re-test ${f.jiraKey || "the requirement"} after a change` : `Test ${f.jiraKey || f.url || file?.name || "the requirement"}`, project: f.project, stages: ["scenarios", "cases", "testdata", ...(f.repo ? ["traceability"] : []), "signoff"] };
      if (f.text.trim()) body.requirement = f.text; else if (file) body.requirementFile = { name: file.name, base64: await toB64(file) }; else if (f.url.trim()) body.requirementUrl = f.url.trim(); else if (f.jiraKey.trim()) body.jiraKey = f.jiraKey.trim();
      else throw new Error("Give me a link, a file, a Jira key, or paste the requirement.");
      if (f.jiraKey.trim()) body.jiraKey = f.jiraKey.trim();
      if (f.appUrl) body.appUrl = f.appUrl;
      if (f.repo) body.repo = { provider: f.provider, project: f.repo };
      if (f.testData.trim()) { try { body.testData = JSON.parse(f.testData); } catch { throw new Error('Test data must be JSON like {"LOGIN_USER":"me"}.'); } }
      const out = await startRun(body);
      nav(`/journey/${out.runId}`);
    } catch (e) { setErr(e); } finally { setBusy(false); }
  }
  return (
    <div className="page narrow">
      <div><h1>What should we test?</h1><div className="sub">Give the AI your requirements. It reads them, writes the test cases and sorts them: the ones it can run itself, and the ones that need you.</div></div>
      <Card hi>
        <label htmlFor="url">Paste a link or drop a file</label>
        <input id="url" value={f.url} onChange={set("url")} placeholder="https://… (any public page, Jira link, PDF, Word, Excel, OpenAPI)" />
        <div className="row"><input aria-label="Choose file" type="file" style={{ width: "auto" }} onChange={(e) => setFile(e.target.files[0] || null)} />{file ? <Chip kind="info">{file.name}</Chip> : null}</div>
        <div className="row">{SOURCES.map((s) => <Chip key={s}>{s}</Chip>)}</div>
        <label htmlFor="text">Or paste the requirement</label>
        <textarea id="text" value={f.text} onChange={set("text")} />
        <div className="grid">
          <div><label htmlFor="jira">Jira key (optional)</label><input id="jira" value={f.jiraKey} onChange={set("jiraKey")} placeholder="TOP-Req-188" /></div>
          <div><label htmlFor="proj">Into project</label><input id="proj" value={f.project} onChange={set("project")} placeholder="CH-TestOps" /></div>
          <div><label htmlFor="app">App address (optional)</label><input id="app" value={f.appUrl} onChange={set("appUrl")} placeholder="https://test.example.com" /></div>
        </div>
        <div className="grid">
          <div><label htmlFor="prov">Where sessions are stored</label><select id="prov" value={f.provider} onChange={set("provider")}><option value="github">GitHub</option><option value="gitlab">GitLab</option></select></div>
          <div><label htmlFor="repo">Repository (check requirements vs built)</label><input id="repo" value={f.repo} onChange={set("repo")} placeholder="owner/name" /></div>
        </div>
        <label htmlFor="td">Test data you already have (JSON, optional)</label>
        <textarea id="td" value={f.testData} onChange={set("testData")} placeholder='{"LOGIN_USER": "qa-user"}' style={{ minHeight: 56 }} />
        <div className="sub">Private pages need a one-time sign-in using the Jira and other connections set up on the server. Nothing is changed in those tools. Passwords and keys are hidden from the AI.</div>
        <ErrorNote error={err} />
        <div className="row"><span className="grow" /><Btn pri onClick={go} disabled={busy}>{busy ? "Reading…" : "Read and plan"}</Btn></div>
      </Card>
    </div>
  );
}
