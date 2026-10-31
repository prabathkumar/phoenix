import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { api } from "../api.js";
import { approve, lastRequest, startRun } from "../run.js";
import { Btn, Card, Chip, ErrorNote, StatusChip, useLoad } from "../ui.jsx";

const LEVELS = [["ask-everything", "Ask me about everything"], ["ask-when-matters", "Ask only when it matters"], ["run-everything", "Run everything"]];

export default function Journey() {
  const { id } = useParams();
  const { data, error, reload } = useLoad(() => api.runDetail(id), [id]);
  const [level, setLevel] = useState(() => (lastRequest(id) || {}).autonomy || "ask-when-matters");
  const [err, setErr] = useState(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => { setErr(null); }, [id]);
  if (error) return <div className="page"><ErrorNote error={error} /></div>;
  if (!data) return <div className="page"><div className="sub">Loading…</div></div>;
  const run = data.run;
  const needs = run.stages.filter((s) => s.status === "needs-you");
  const req = lastRequest(id);

  async function again(extra) {
    setBusy(true); setErr(null);
    try { const out = await startRun({ ...req, ...extra, autonomy: level }); window.location.assign(`/journey/${out.runId}`); } catch (e) { setErr(e); setBusy(false); }
  }
  async function ok(stageId) {
    setBusy(true); setErr(null);
    try { const out = await approve(id, stageId); window.location.assign(`/journey/${out.runId}`); } catch (e) { setErr(e); setBusy(false); }
  }
  return (
    <div className="page narrow">
      <div className="row"><div className="grow"><h1>AI Test Manager</h1><div className="sub">Goal: {run.goal}. The AI plans it, runs it and tells you when it needs you.</div></div><Chip kind="info">{run.plan ? `Plan: ${run.plan.source}` : "Plan"}</Chip></div>
      <Card>
        <b>How much should the AI ask you?</b>
        <div className="row" role="radiogroup">{LEVELS.map(([v, t]) => <button key={v} role="radio" aria-checked={level === v} className={`chip ${level === v ? "info" : "mut"}`} onClick={() => setLevel(v)}>{t}</button>)}</div>
        <div className="sub">Live security scans and anything on production always ask, whichever you pick.</div>
        {req ? <div className="row"><Btn onClick={() => again({})} disabled={busy}>Run again at this level</Btn></div> : null}
      </Card>
      <Card>
        <b>The plan, and what the AI decided</b>
        {run.stages.filter((s) => s.status !== "skipped").map((s) => (
          <div className="stage" key={s.id}><StatusChip status={s.status} /><div className="grow"><b>{s.id}</b><div className="sub">{s.detail}{s.decided ? ` · ${s.decided}` : ""}</div>{s.ai ? <div className="sub">AI: {s.ai}</div> : null}</div></div>
        ))}
        {!run.stages.some((s) => s.status !== "skipped") ? <div className="sub">No stages ran.</div> : null}
      </Card>
      <Card hi={needs.length > 0}>
        <div className="row"><b>Needs you</b>{needs.length ? <Chip kind="warn">{needs.length} item{needs.length > 1 ? "s" : ""}</Chip> : null}</div>
        {needs.length === 0 ? <div className="sub">Nothing is waiting for an approval.</div> : needs.map((s) => (
          <div className="row" key={s.id}><div className="grow"><b>{s.id}</b><div className="sub">{s.detail}</div></div><Btn pri onClick={() => ok(s.id)} disabled={busy}>Approve and run</Btn></div>
        ))}
        <ErrorNote error={err} />
      </Card>
      <div className="row"><Link className="btn" to="/cases">Review the test cases</Link><Link className="btn" to={`/runs/${id}`}>Open the run result</Link><Btn onClick={reload}>Refresh</Btn></div>
      <Card><b>The AI will not do these without you</b><div className="sub">Scan a live app with attack traffic. Run anything against production. Change or delete your existing records. Share secret values. Sign anything off.</div></Card>
    </div>
  );
}
