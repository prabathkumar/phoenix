import { useState } from "react";
import { api } from "../api.js";
import { Btn, Card, Chip, ErrorNote, useLoad } from "../ui.jsx";

export default function Training() {
  const [project, setProject] = useState(""), [err, setErr] = useState(null), [note, setNote] = useState({});
  const s = useLoad(() => api.trainingStatus(project), [project]);
  const q = useLoad(() => api.logTable("training_examples", { project, n: 50 }), [project]);
  const d = s.data, st = d && d.stats;
  const act = async (fn) => { setErr(null); try { await fn(); s.reload(); q.reload(); } catch (e) { setErr(e); } };
  const need = st ? Math.max(0, st.minToTrain - st.train) : 0;
  return (
    <div className="page">
      <div><h1>Model training</h1><div className="sub">The 8B model learns from answers that a person has marked good or corrected. Nothing trains or goes live on its own: a training job must pass an evaluation gate, and a second person promotes it.</div></div>
      <div className="row"><input placeholder="project id (all if empty)" value={project} onChange={(e) => setProject(e.target.value)} style={{ maxWidth: 260 }} />
        {st ? <Chip kind={st.capture ? "ok" : "warn"}>{st.capture ? "capture on" : "capture off (set PHOENIX_TRAIN_CAPTURE=1)"}</Chip> : null}</div>
      <ErrorNote error={err || s.error} />
      {st ? <Card hi><b>Training data</b>
        <div className="row" style={{ flexWrap: "wrap" }}>{[["Captured", st.total], ["Usable (good or corrected)", st.usable], ["Train", st.train], ["Held-out eval", st.eval]].map(([l, v]) => <div key={l} className="card" style={{ minWidth: 130 }}><div className="sub">{l}</div><div style={{ fontSize: 24, fontWeight: 700 }}>{v}</div></div>)}</div>
        <div className="sub">By label: {Object.entries(st.byOutcome).map(([k, v]) => `${k} ${v}`).join(" · ") || "none yet"}. {need ? `${need} more usable example(s) needed before a job can start.` : "Enough to train."}</div>
        <div className="row"><Btn pri disabled={need > 0 || !st.eval} onClick={() => act(() => api.trainingStart({ project }))}>Start a training job</Btn><span className="sub">QLoRA on Qwen3-8B. The job is prepared here and run on the GPU box (the command is shown on the job).</span></div></Card> : null}
      <Card><b>Label captured answers</b><div className="sub">Mark what the model said as good, bad, or give the better answer. Only labelled examples are used.</div>
        {(q.data ? q.data.rows : []).filter((r) => r.outcome === "unknown").slice(0, 10).map((r, i) => <div key={i} className="card" style={{ marginTop: 8 }}>
          <div className="sub">{r.source} · {String(r.at).slice(0, 19)}</div><div><b>Prompt</b> <span className="sub">{r.prompt.slice(0, 300)}</span></div><div><b>Answer</b> <span className="sub">{r.response.slice(0, 300)}</span></div>
          <div className="row"><Btn onClick={() => act(() => api.trainingLabel({ project: r.project, source: r.source, prompt: r.prompt, response: r.response, outcome: "good" }))}>Good</Btn>
            <Btn onClick={() => act(() => api.trainingLabel({ project: r.project, source: r.source, prompt: r.prompt, response: r.response, outcome: "bad" }))}>Bad</Btn>
            <input placeholder="the better answer" value={note[i] || ""} onChange={(e) => setNote({ ...note, [i]: e.target.value })} />
            <Btn disabled={!note[i]} onClick={() => act(() => api.trainingLabel({ project: r.project, source: r.source, prompt: r.prompt, response: r.response, outcome: "corrected", preferred: note[i] }))}>Correct</Btn></div></div>)}
        {q.data && !q.data.rows.some((r) => r.outcome === "unknown") ? <div className="sub">Nothing waiting for a label.</div> : null}</Card>
      <Card><b>Training jobs</b> {d ? <Chip kind="mut">live model: {d.live.model}{d.live.adapter ? " + tuned adapter" : ""}</Chip> : null}
        {d && !d.jobs.length ? <div className="sub">No jobs yet.</div> : null}
        {(d ? d.jobs : []).map((j) => <div key={j.id} className="card" style={{ marginTop: 8 }}>
          <div className="row"><b>{j.id}</b><Chip kind={j.status === "promoted" ? "ok" : j.status === "rejected-by-gate" || j.status === "failed" ? "bad" : j.status === "ready-for-review" ? "info" : "mut"}>{j.status}</Chip><span className="sub">started by {j.by} · {j.dataset.train} train / {j.dataset.eval} eval</span>{j.progress != null ? <span className="sub">{Math.round(j.progress * 100)}%{j.loss != null ? ` · loss ${j.loss}` : ""}</span> : null}</div>
          {j.metrics ? <div className="sub">Tuned {j.metrics.tuned_score} vs live {j.metrics.live_score} on {j.metrics.eval_examples} held-out · well-formed {Math.round(j.metrics.tuned_valid * 100)}%</div> : null}
          {j.gate ? <div className="sub">Gate: {j.gate.passed ? "passed" : j.gate.reasons.join("; ")}</div> : null}
          {j.note ? <div className="sub">{j.note}</div> : null}
          {j.status === "queued" ? <pre style={{ overflow: "auto" }}>{j.command}</pre> : null}
          {j.status === "ready-for-review" ? <div className="row"><input placeholder="why you approve this model (10+ characters)" value={note[j.id] || ""} onChange={(e) => setNote({ ...note, [j.id]: e.target.value })} style={{ minWidth: 260 }} /><Btn pri disabled={(note[j.id] || "").length < 10} onClick={() => act(() => api.trainingPromote(j.id, note[j.id]))}>Promote</Btn></div> : null}
          {j.promoted ? <div className="sub">Promoted by {j.promoted.by}: {j.promoted.note}</div> : null}</div>)}</Card>
    </div>
  );
}
