import { useState } from "react";
import { Link, useParams } from "react-router-dom";
import { api } from "../api.js";
import { Btn, Card, Chip, ErrorNote, StatusChip, useLoad } from "../ui.jsx";

export default function Result() {
  const { id } = useParams();
  const { data, error, reload } = useLoad(() => api.runDetail(id), [id]);
  const [err, setErr] = useState(null);
  if (error) return <div className="page"><ErrorNote error={error} /></div>;
  if (!data) return <div className="page"><div className="sub">Loading…</div></div>;
  const { run, executions, checks, calls } = data;
  const last = {};
  executions.forEach((e) => { last[e.caseId] = e; });
  const rows = Object.values(last);
  const count = (r, who) => rows.filter((x) => x.result === r && (!who || x.who === who)).length;
  const failed = rows.filter((x) => x.result === "failed");
  const tr = run.traceability;

  async function ask() { setErr(null); try { await api.requestRun(id, ""); reload(); } catch (e) { setErr(e); } }
  return (
    <div className="page">
      <div className="row"><div className="grow"><h1>Run finished: {count("passed")} passed, {count("failed")} failed</h1><div className="sub">{run.goal}{run.requirement ? ` · ${run.requirement}` : ""} · {run.id}</div></div><Btn onClick={ask}>Request release sign-off</Btn></div>
      <ErrorNote error={err} />
      <div className="grid">
        <div className="stat"><span className="sub">Passed by AI</span><b>{count("passed", "ai")}</b></div>
        <div className="stat"><span className="sub">Failed by AI</span><b>{count("failed", "ai")}</b></div>
        <div className="stat"><span className="sub">Passed by you</span><b>{count("passed", "human")}</b></div>
        <div className="stat"><span className="sub">Model calls</span><b>{calls.length}</b></div>
      </div>
      <Card>
        <table>
          <thead><tr><th>Test case</th><th>Who</th><th>Result</th></tr></thead>
          <tbody>
            {rows.map((r) => <tr key={r.caseId}><td><b>{r.caseId}</b>{r.detail ? <div className="sub">{r.detail}</div> : null}</td><td>{r.who === "ai" ? <Chip kind="info">AI ran it</Chip> : <Chip>You ran it</Chip>}</td><td><Chip kind={r.result === "passed" ? "ok" : r.result === "failed" ? "bad" : "warn"}>{r.result}</Chip></td></tr>)}
            {!rows.length ? <tr><td colSpan="3" className="sub">No case results were recorded for this run.</td></tr> : null}
          </tbody>
        </table>
      </Card>
      {failed.map((f) => (
        <Card key={f.caseId} hi>
          <b>{f.caseId} failed</b><div className="sub">{f.detail || "No detail recorded."}</div>
          <div className="row"><Link className="btn" to={`/guided/${id}/${f.caseId}`}>Do it myself, AI guides</Link><Link className="btn" to="/defects">Log in Jira</Link></div>
        </Card>
      ))}
      <Card>
        <b>Release checks</b>
        {checks.checks.map((c) => <div className="row" key={c.name}><Chip kind={c.ok ? "ok" : "bad"}>{c.ok ? "OK" : "Not OK"}</Chip><b>{c.name}</b><span className="sub">{c.detail}</span></div>)}
        <div className="sub">A person approves the release on the <Link to="/signoff">Sign-off</Link> page. Failing checks can only be accepted with a written reason.</div>
      </Card>
      {tr ? <Card><b>Requirements vs what is built</b><div>{tr.requirements} requirements: {tr.covered} covered, {tr.partial} partial, {tr.missing} missing; {tr.unrequired} tests have no requirement.</div></Card> : null}
      <Card>
        <b>What each stage did</b>
        {run.stages.filter((s) => s.status !== "skipped").map((s) => <div className="stage" key={s.id}><StatusChip status={s.status} /><div className="grow"><b>{s.id}</b><div className="sub">{s.detail}</div></div></div>)}
      </Card>
    </div>
  );
}
