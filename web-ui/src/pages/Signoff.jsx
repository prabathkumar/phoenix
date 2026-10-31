import { useState } from "react";
import { Link } from "react-router-dom";
import { api, getUser } from "../api.js";
import { Btn, Card, Chip, ErrorNote, SignoffChip, useLoad } from "../ui.jsx";

const when = (s) => (s ? s.slice(0, 16).replace("T", " ") : "");

function Item({ so, onDone }) {
  const [note, setNote] = useState("");
  const [err, setErr] = useState(null);
  const [checks, setChecks] = useState(null);
  const run = so.kind === "run";
  useLoad(async () => { if (run && so.status === "pending") setChecks((await api.runDetail(so.subject)).checks); return null; }, [so.id]);
  async function decide(d) { setErr(null); try { await api.decide(so.id, d, note); setNote(""); onDone(); } catch (e) { setErr(e); } }
  const me = getUser().trim().toLowerCase();
  const mine = me && me === so.requestedBy.toLowerCase();
  return (
    <Card hi={so.status === "pending"}>
      <div className="row"><div className="grow"><b>{run ? "Release sign-off" : "Test case"} · {run ? <Link to={`/runs/${so.subject}`}>{so.subject}</Link> : so.subject}</b><div className="sub">Requested by {so.requestedBy} · {when(so.createdAt)}</div></div>
        {so.status === "pending" ? <Chip kind="warn">Waiting for sign-off</Chip> : <SignoffChip state={so.status} />}</div>
      {checks ? checks.checks.map((c) => <div className="row" key={c.name}><Chip kind={c.ok ? "ok" : "bad"}>{c.ok ? "OK" : "Not OK"}</Chip><span>{c.name}</span><span className="sub">{c.detail}</span></div>) : null}
      {so.status === "pending" ? <>
        {mine ? <div className="note">You asked for this sign-off, so a colleague has to decide it.</div> : null}
        <label htmlFor={`n${so.id}`}>Note {checks && !checks.pass ? "(required to approve with exceptions)" : "(required to reject or ask for changes)"}</label>
        <input id={`n${so.id}`} value={note} onChange={(e) => setNote(e.target.value)} />
        <ErrorNote error={err} />
        <div className="row"><Btn pri disabled={mine} onClick={() => decide("approved")}>{checks && !checks.pass ? "Approve with exceptions" : "Approve"}</Btn><Btn onClick={() => decide("changes-requested")}>Ask for changes</Btn><Btn onClick={() => decide("rejected")}>Reject</Btn></div></> : <div className="sub">{so.status} by {so.decidedBy}{so.note ? `: ${so.note}` : ""}</div>}
      <details><summary className="sub">Audit trail ({so.trail.length})</summary>{so.trail.map((e, i) => <div className="sub" key={i}>{when(e.at)} · {e.actor} · {e.action}{e.note ? ` · ${e.note}` : ""}</div>)}</details>
    </Card>
  );
}

export default function Signoff() {
  const [tab, setTab] = useState("pending");
  const { data, error, reload } = useLoad(() => api.signoffs(tab === "pending" ? { status: "pending" } : {}), [tab]);
  const f = data && data.funnel;
  return (
    <div className="page narrow">
      <div><h1>Sign-off</h1><div className="sub">Nothing is released on the AI's say-so. A colleague approves each test case and each release, and every decision is kept in an audit trail.</div></div>
      {f ? <div className="grid">{Object.entries(f.cases).map(([k, v]) => <div className="stat" key={k}><span className="sub">Cases · {k}</span><b>{v}</b></div>)}<div className="stat"><span className="sub">Releases waiting</span><b>{f.runs.pending}</b></div></div> : null}
      <div className="row"><button className={`chip ${tab === "pending" ? "info" : "mut"}`} onClick={() => setTab("pending")}>Waiting for you</button><button className={`chip ${tab === "all" ? "info" : "mut"}`} onClick={() => setTab("all")}>History</button></div>
      <ErrorNote error={error} />
      {data && !data.signoffs.length ? <div className="sub">{tab === "pending" ? "Nothing is waiting for sign-off." : "No sign-offs yet."}</div> : null}
      {(data ? data.signoffs : []).map((so) => <Item key={so.id} so={so} onDone={reload} />)}
    </div>
  );
}
