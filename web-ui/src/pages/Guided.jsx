import { useState } from "react";
import { Link, useParams } from "react-router-dom";
import { api } from "../api.js";
import { Btn, Card, Chip, ErrorNote, useLoad } from "../ui.jsx";

export default function Guided() {
  const { runId, caseId } = useParams();
  const { data, error } = useLoad(() => api.cases());
  const [step, setStep] = useState(0);
  const [note, setNote] = useState("");
  const [done, setDone] = useState(null);
  const [err, setErr] = useState(null);
  const c = data && data.cases.find((x) => x.id === caseId);
  if (error) return <div className="page"><ErrorNote error={error} /></div>;
  if (!data) return <div className="page"><div className="sub">Loading…</div></div>;
  if (!c) return <div className="page"><h1>Case not found</h1></div>;
  const steps = c.steps || [];
  const n = steps.length || 1;

  async function mark(result) {
    setErr(null);
    try {
      if (result === "passed" && step < n - 1) { setStep(step + 1); setNote(""); return; }
      const final = result === "passed" ? "passed" : result;
      await api.execution({ runId, caseId, result: final, note: `Step ${step + 1} of ${n}${note ? `: ${note}` : ""}` });
      setDone(final);
    } catch (e) { setErr(e); }
  }
  if (done) return (
    <div className="page narrow"><h1>Recorded: {done}</h1><div className="sub">Your result for {c.id} is saved under your name.</div>
      <div className="row"><Link className="btn pri" to={`/runs/${runId}`}>Back to the run result</Link>{done === "failed" ? <Link className="btn" to="/defects">Log the defect in Jira</Link> : null}</div></div>
  );
  return (
    <div className="page narrow">
      <div className="row"><div className="grow"><h1>Your turn</h1><div className="sub">The AI did the setup, you check the result.</div></div><Chip kind="info">Guided by AI</Chip></div>
      <Card hi>
        <div className="sub">Step {step + 1} of {n}</div>
        <b>{c.id}, {c.title}</b>
        <div>{steps[step] || "Run this case and tell me what happened."}</div>
        <label htmlFor="note">Note (optional)</label>
        <textarea id="note" value={note} onChange={(e) => setNote(e.target.value)} />
        <ErrorNote error={err} />
        <div className="row"><Btn pri onClick={() => mark("passed")}>Pass</Btn><Btn onClick={() => mark("failed")}>Fail</Btn><Btn onClick={() => mark("blocked")}>Cannot do this step</Btn></div>
        <div className="sub">If you press Fail, a defect is drafted for you to confirm in Jira. Steps before this one: {step}.</div>
      </Card>
    </div>
  );
}
