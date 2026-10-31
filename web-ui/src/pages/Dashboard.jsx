import { useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../api.js";
import { Card, Chip, ErrorNote, pct, useLoad } from "../ui.jsx";

function Bars({ rows, label }) {
  const max = Math.max(1, ...rows.map((r) => r.passed + r.failed + (r.other || 0)));
  return (
    <div role="img" aria-label={label}>
      <div className="bar">{rows.map((r) => <div key={r.day} title={`${r.day}: ${r.passed} passed, ${r.failed} failed`}><i className="f" style={{ height: `${(r.failed / max) * 100}%` }} /><i style={{ height: `${(r.passed / max) * 100}%` }} /></div>)}</div>
      <div className="row sub" style={{ justifyContent: "space-between" }}><span>{rows[0] && rows[0].day}</span><span>{rows.length ? rows[rows.length - 1].day : ""}</span></div>
    </div>
  );
}
const Stat = ({ k, v, sub }) => <div className="stat"><span className="sub">{k}</span><b>{v}</b>{sub ? <span className="sub">{sub}</span> : null}</div>;

export default function Dashboard() {
  const [days, setDays] = useState(14);
  const { data: d, error } = useLoad(() => api.dashboard(days), [days]);
  if (error) return <div className="page"><ErrorNote error={error} /></div>;
  if (!d) return <div className="page"><div className="sub">Loading…</div></div>;
  const ex = d.execution, so = d.signoff, ai = d.ai;
  const note = d.stores.analytics.note;
  return (
    <div className="page">
      <div className="row"><div className="grow"><h1>Monitoring</h1><div className="sub">Test execution, sign-off and the AI, for the last {days} days.</div></div>
        {[7, 14, 30].map((n) => <button key={n} className={`chip ${days === n ? "info" : "mut"}`} onClick={() => setDays(n)}>{n} days</button>)}</div>
      {note ? <div className="note">AI telemetry: {note}.</div> : null}

      <h2>Test execution</h2>
      <div className="grid">
        <Stat k="Pass rate" v={pct(ex.passRate)} sub={`${ex.passed} passed, ${ex.failed} failed`} />
        <Stat k="Executions" v={ex.total} />
        <Stat k="AI ran" v={(ex.byWho.ai || { passed: 0, failed: 0 }).passed + (ex.byWho.ai || { passed: 0, failed: 0 }).failed} />
        <Stat k="People ran" v={(ex.byWho.human || { passed: 0, failed: 0 }).passed + (ex.byWho.human || { passed: 0, failed: 0 }).failed} />
      </div>
      <Card><b>Results per day</b>{ex.perDay.length ? <Bars rows={ex.perDay} label="Passed and failed executions per day" /> : <div className="sub">No executions in this period.</div>}
        <div className="row sub"><Chip kind="ok">passed</Chip><Chip kind="bad">failed</Chip></div></Card>
      {ex.topFailing.length ? <Card><b>Cases that fail most</b><table><tbody>{ex.topFailing.map((c) => <tr key={c.caseId}><td>{c.caseId}</td><td>{c.failures} failure(s)</td></tr>)}</tbody></table></Card> : null}

      <h2>Test case sign-off</h2>
      <div className="grid">{Object.entries(so.cases).map(([k, v]) => <Stat key={k} k={k} v={v} />)}<Stat k="Releases waiting" v={so.runs.pending} /><Stat k="Releases approved" v={so.runs.approved} /></div>
      <Card><div className="row"><b className="grow">Waiting on a person</b><Link className="btn" to="/signoff">Open sign-off</Link></div>
        {so.waitingOnYou.length ? <table><tbody>{so.waitingOnYou.map((w) => <tr key={w.id}><td>{w.kind === "run" ? "Release" : "Case"} {w.subject}</td><td>asked by {w.requestedBy}</td><td className="sub">{w.since.slice(0, 10)}</td></tr>)}</tbody></table> : <div className="sub">Nothing is waiting.</div>}</Card>

      <h2>The AI</h2>
      <div className="grid">
        <Stat k="Model calls" v={ai.calls.total} sub={`${ai.calls.ok} ok, ${ai.calls.fellBack} used a fallback`} />
        <Stat k="Latency p50 / p95" v={`${ai.calls.p50} / ${ai.calls.p95} ms`} />
        <Stat k="Guardrail hits" v={ai.guardrailHits.reduce((a, h) => a + h.count, 0)} />
      </div>
      <div className="grid">
        <Card><b>By model</b>{ai.byModel.length ? <table><tbody>{ai.byModel.map((m) => <tr key={m.model}><td>{m.model}</td><td>{m.calls} calls</td><td className="sub">p95 {m.p95} ms</td></tr>)}</tbody></table> : <div className="sub">No calls yet.</div>}</Card>
        <Card><b>AI answer quality (DeepEval)</b>{ai.evals.length ? <table><tbody>{ai.evals.map((e) => <tr key={e.metric}><td>{e.metric}</td><td>avg {e.avg}</td><td className="sub">{pct(e.passRate)} pass</td></tr>)}</tbody></table> : <div className="sub">No evaluations yet.</div>}</Card>
      </div>
      <Card><b>Pipeline stage reliability</b>{ai.stages.length ? <table><thead><tr><th>Stage</th><th>Runs</th><th>Failed</th><th>Waiting on you</th><th>Avg time</th></tr></thead><tbody>{ai.stages.map((s) => <tr key={s.stage}><td>{s.stage}</td><td>{s.runs}</td><td>{s.failed ? <Chip kind="bad">{s.failed}</Chip> : 0}</td><td>{s.needsYou}</td><td>{s.avgMs} ms</td></tr>)}</tbody></table> : <div className="sub">No pipeline runs yet.</div>}</Card>
      <div className="sub">Stores: results and sign-off in {d.stores.postgres === "postgresql" ? "PostgreSQL" : `${d.stores.postgres} (local fallback, not PostgreSQL)`}; AI telemetry in {d.stores.analytics.backend === "clickhouse" ? "ClickHouse" : "memory (ClickHouse not set up)"}.</div>
    </div>
  );
}
