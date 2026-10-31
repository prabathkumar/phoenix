import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { api } from "../api.js";
import { Btn, Card, Chip, ErrorNote, StatusChip, useLoad } from "../ui.jsx";
import { startRun } from "../run.js";

export default function Landing() {
  const nav = useNavigate();
  const [goal, setGoal] = useState("");
  const [err, setErr] = useState(null);
  const [busy, setBusy] = useState(false);
  const dash = useLoad(() => api.dashboard(7));
  const runs = useLoad(() => api.runs());
  const waiting = dash.data ? dash.data.signoff.waitingOnYou : [];
  const last = runs.data && runs.data.runs[0];

  async function send() {
    if (!goal.trim()) return;
    setBusy(true); setErr(null);
    try {
      const isLink = /^https?:\/\//i.test(goal.trim());
      const out = await startRun({ goal: goal.trim(), ...(isLink ? { requirementUrl: goal.trim() } : { requirement: goal.trim() }), stages: ["scenarios", "cases", "testdata", "signoff"], project: "" });
      nav(`/journey/${out.runId}`);
    } catch (e) { setErr(e); } finally { setBusy(false); }
  }
  return (
    <div className="page narrow">
      <div className="row">
        <div style={{ width: 48, height: 48, borderRadius: "50%", background: "var(--accent)", color: "var(--accentInk)", display: "flex", alignItems: "center", justifyContent: "center" }} aria-hidden="true">
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z" /></svg>
        </div>
        <div className="grow"><b>Your Test Manager</b><div className="sub">AI, working in Phoenix</div></div>
        {waiting.length ? <Chip kind="warn">{waiting.length} waiting on a person</Chip> : <Chip kind="ok">Nothing waiting on you</Chip>}
      </div>
      <h1>What would you like me to do today?</h1>
      <Card hi>
        <label htmlFor="goal">Tell me, or paste a link</label>
        <input id="goal" value={goal} onChange={(e) => setGoal(e.target.value)} onKeyDown={(e) => e.key === "Enter" && send()} placeholder="A Jira, SharePoint or web link, a change request, or just describe it" />
        <div className="row">
          <Link className="chip info" to="/start">Test a new requirement</Link>
          <Link className="chip info" to="/start?retest=1">Re-test after a change request</Link>
          <Link className="chip info" to="/cases">Review my test cases</Link>
          <Link className="chip info" to="/runs">Continue where I left off</Link>
          <span className="grow" />
          <Btn pri onClick={send} disabled={busy || !goal.trim()}>{busy ? "Working…" : "Send"}</Btn>
        </div>
        <ErrorNote error={err} />
      </Card>
      <section style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        <div className="row"><b>Pending with you</b>{waiting.length ? <Chip kind="warn">{waiting.length} item{waiting.length > 1 ? "s" : ""}</Chip> : null}</div>
        {dash.error ? <ErrorNote error={dash.error} /> : null}
        {!waiting.length && !dash.loading ? <div className="sub">Nothing is waiting for your sign-off.</div> : null}
        {waiting.slice(0, 5).map((w) => (
          <Card key={w.id}><div className="row"><div className="grow"><b>{w.kind === "run" ? `Release sign-off for ${w.subject}` : `Approve test case ${w.subject}`}</b><div className="sub">Requested by {w.requestedBy}</div></div><Link className="btn" to="/signoff">Review</Link></div></Card>
        ))}
      </section>
      <Card>
        <b>What I did last</b>
        {last ? <div>Run <Link to={`/runs/${last.id}`}>{last.id}</Link>: <b>{last.goal || "no goal"}</b>. Execution <StatusChip status={last.execution || "skipped"} />{last.defects ? `, ${last.defects} defect(s) logged` : ""}.</div> : <div className="sub">No runs yet. Give me a requirement above.</div>}
      </Card>
      <div className="sub">I will never scan a live app, touch production, or change your existing records without asking you first. I never sign anything off: people do.</div>
    </div>
  );
}
