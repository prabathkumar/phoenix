import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { api } from "../api.js";
import { startRun } from "../run.js";
import { Btn, Card, Chip, ErrorNote, SignoffChip, useLoad } from "../ui.jsx";

export default function Cases() {
  const { data, error, reload } = useLoad(() => api.cases());
  const [sel, setSel] = useState({});
  const [drawer, setDrawer] = useState(false);
  const [err, setErr] = useState(null);
  const cases = data ? data.cases : [];
  const chosen = cases.filter((c) => sel[c.id]);
  const total = cases.length;
  const approved = cases.filter((c) => c.signoff === "approved").length;

  async function request() {
    setErr(null);
    try { for (const c of chosen) if (["draft", "changes-requested", "rejected"].includes(c.signoff)) await api.requestCase(c.id, ""); setSel({}); reload(); } catch (e) { setErr(e); }
  }
  return (
    <div className="page">
      <div className="row"><div className="grow"><div className="sub">Test Management / Test Case</div><h1>Test cases</h1></div></div>
      <div className="grid">
        <div className="stat"><span className="sub">Total test cases</span><b>{total}</b></div>
        <div className="stat"><span className="sub">Approved</span><b>{approved}</b></div>
        <div className="stat"><span className="sub">Waiting for sign-off</span><b>{cases.filter((c) => c.signoff === "pending").length}</b></div>
        <div className="stat"><span className="sub">AI can run</span><b>{cases.filter((c) => c.who === "ai").length}</b></div>
      </div>
      <Card hi>
        <b>One run, two kinds of case</b>
        <div className="sub">The AI runs the cases it can do itself, one after another. When it reaches one that needs a person, it stops and guides you. Only approved cases should be run for a release.</div>
        <div className="row">
          <Chip kind="info">{chosen.length} selected</Chip>
          <span className="grow" />
          <Btn onClick={() => setSel({})} disabled={!chosen.length}>Clear</Btn>
          <Btn onClick={request} disabled={!chosen.length}>Request sign-off</Btn>
          <Btn pri onClick={() => setDrawer(true)} disabled={!chosen.length}>Start run ({chosen.length})</Btn>
        </div>
        <ErrorNote error={err || error} />
      </Card>
      <Card>
        <table>
          <thead><tr><th style={{ width: 28 }}><input type="checkbox" aria-label="Select all" style={{ width: "auto" }} checked={total > 0 && chosen.length === total} onChange={(e) => setSel(e.target.checked ? Object.fromEntries(cases.map((c) => [c.id, true])) : {})} /></th><th>Test case</th><th>Sign-off</th><th>Priority</th><th>Who runs it</th></tr></thead>
          <tbody>
            {cases.map((c) => (
              <tr key={c.id}>
                <td><input type="checkbox" aria-label={`Select ${c.id}`} style={{ width: "auto" }} checked={!!sel[c.id]} onChange={(e) => setSel({ ...sel, [c.id]: e.target.checked })} /></td>
                <td><b>{c.title}</b><div className="sub">{c.id}{c.requirement ? ` · ${c.requirement}` : ""}</div></td>
                <td><SignoffChip state={c.signoff} /></td>
                <td>{c.priority}</td>
                <td>{c.who === "ai" ? <Chip kind="info">AI runs it</Chip> : <Chip>You do it, AI guides</Chip>}</td>
              </tr>
            ))}
            {!cases.length ? <tr><td colSpan="5" className="sub">No test cases yet. <Link to="/start">Give the AI a requirement</Link> and it will write them.</td></tr> : null}
          </tbody>
        </table>
      </Card>
      {drawer ? <RunDrawer cases={chosen} onClose={() => setDrawer(false)} /> : null}
    </div>
  );
}

function RunDrawer({ cases, onClose }) {
  const nav = useNavigate();
  const [f, setF] = useState({ url: "", runOn: "local", tdata: "" });
  const [err, setErr] = useState(null);
  const [busy, setBusy] = useState(false);
  const unapproved = cases.filter((c) => c.signoff !== "approved");
  async function start() {
    setBusy(true); setErr(null);
    try {
      let testData = {};
      if (f.tdata.trim()) { try { testData = JSON.parse(f.tdata); } catch { throw new Error("Test data must be JSON."); } }
      const out = await startRun({ goal: `Run ${cases.length} test case(s)`, requirement: cases.map((c) => c.title).join("\n"), web: { url: f.url, runOn: f.runOn, steps: "" }, testData, stages: ["execution", "har", "defects", "signoff"], cases: cases.map((c) => ({ id: c.id })), autonomy: "ask-when-matters" });
      nav(`/runs/${out.runId}`);
    } catch (e) { setErr(e); } finally { setBusy(false); }
  }
  return (
    <aside role="dialog" aria-label="Ready to run" className="card hi">
      <div className="row"><h2 className="grow">Ready to run {cases.length} case{cases.length > 1 ? "s" : ""}</h2><Btn onClick={onClose}>Close</Btn></div>
      <div className="sub">Where it runs and which test data it uses. Nothing runs until you press Start.</div>
      {unapproved.length ? <div className="note">{unapproved.length} of these cases are not approved yet. You can run them to try them out, but a release sign-off will not pass until they are approved.</div> : null}
      <label htmlFor="d-url">App address</label><input id="d-url" value={f.url} onChange={(e) => setF({ ...f, url: e.target.value })} placeholder="https://test.example.com" />
      <label htmlFor="d-on">Where</label><select id="d-on" value={f.runOn} onChange={(e) => setF({ ...f, runOn: e.target.value })}><option value="local">Local</option><option value="browserstack">BrowserStack</option></select>
      <label htmlFor="d-td">Test data (JSON, passwords stay hidden from the AI)</label><textarea id="d-td" value={f.tdata} onChange={(e) => setF({ ...f, tdata: e.target.value })} style={{ minHeight: 56 }} />
      <div className="sub">Safety: stop at first failure, ask before risky actions.</div>
      <ErrorNote error={err} />
      <div className="row"><span className="grow" /><Btn pri onClick={start} disabled={busy}>{busy ? "Starting…" : "Start run"}</Btn></div>
    </aside>
  );
}
