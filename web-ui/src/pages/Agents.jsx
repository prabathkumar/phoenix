import { useState } from "react";
import { Link } from "react-router-dom";
import { api, getUser } from "../api.js";
import { Btn, Card, Chip, ErrorNote, useLoad } from "../ui.jsx";

const EMPTY = { name: "", description: "", goal: "", platform: "web", autonomy: "ask-when-matters", stages: [], then: [] };

export default function Agents() {
  const { data, error, reload } = useLoad(() => api.agents());
  const [form, setForm] = useState(null); // an agent being made or changed
  const [editing, setEditing] = useState(false);
  const [err, setErr] = useState(null);
  const [call, setCall] = useState({ agent: "", requirement: "", task: "", appUrl: "" });
  const [result, setResult] = useState(null);
  const [busy, setBusy] = useState(false);
  const agents = data ? data.agents : [];
  const stages = data ? data.stages : [];
  const me = getUser();
  const toggle = (list, v) => (list.includes(v) ? list.filter((x) => x !== v) : [...list, v]);

  async function save() {
    setErr(null);
    try { editing ? await api.updateAgent(form.name, form) : await api.createAgent(form); setForm(null); reload(); } catch (e) { setErr(e); }
  }
  async function flip(a) { setErr(null); try { await api.enableAgent(a.name, !a.enabled); reload(); } catch (e) { setErr(e); } }
  async function edit(a) { setErr(null); try { setForm(await fetch(`/api/agents/${a.name}`).then((r) => r.json())); setEditing(true); } catch (e) { setErr(e); } }
  async function go() {
    setBusy(true); setErr(null); setResult(null);
    try {
      const input = { ...(call.requirement ? { requirement: call.requirement } : {}), ...(call.task ? { task: call.task } : {}), ...(call.appUrl ? { appUrl: call.appUrl } : {}) };
      setResult(await api.callAgent(me, call.agent, input));
    } catch (e) { setErr(e); } finally { setBusy(false); }
  }

  return (
    <div className="page">
      <div className="row"><div className="grow"><div className="sub">AI / Agents</div><h1>Agents</h1></div><Btn pri onClick={() => { setForm({ ...EMPTY }); setEditing(false); }}>Build an agent</Btn></div>
      <Card hi>
        <b>Saved AI workers you can link</b>
        <div className="sub">An agent does one job (scenarios, test cases, a mobile run) and can hand over to the next. Every agent runs through the same gates, approvals and sign-off as a normal run, and an agent never decides on its own that something is safe. Agents built from outside Phoenix (the MCP server) start switched off until a person enables them.</div>
      </Card>
      <ErrorNote error={err || error} />
      <Card>
        <table>
          <thead><tr><th>Agent</th><th>Does</th><th>Then hands over to</th><th>Status</th><th /></tr></thead>
          <tbody>
            {agents.map((a) => (
              <tr key={a.name}>
                <td><b>{a.name}</b><div className="sub">{a.description || ""}</div></td>
                <td><Chip>{a.platform}</Chip> <span className="sub">{a.stages.join(", ")}</span></td>
                <td>{a.then.length ? a.then.join(" → ") : <span className="sub">nobody</span>}</td>
                <td>{a.enabled ? <Chip kind="ok">On</Chip> : <Chip kind="warn">Off, needs a person</Chip>}{a.source === "mcp" ? <div className="sub">built through MCP by {a.createdBy}</div> : null}</td>
                <td><Btn onClick={() => flip(a)}>{a.enabled ? "Switch off" : "Switch on"}</Btn> <Btn onClick={() => edit(a)}>Edit</Btn></td>
              </tr>
            ))}
            {!agents.length ? <tr><td colSpan="5" className="sub">No agents yet. Build one, for example a test-scenarios agent, then a test-cases agent that it hands over to.</td></tr> : null}
          </tbody>
        </table>
      </Card>

      {form ? (
        <Card role="dialog" aria-label="Agent">
          <h2>{editing ? `Change ${form.name}` : "Build an agent"}</h2>
          {editing ? <div className="note">Changing the goal, steps, autonomy or links switches the agent off until a person enables it again.</div> : null}
          <label htmlFor="a-name">Name</label><input id="a-name" value={form.name} disabled={editing} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="test-cases-agent" />
          <label htmlFor="a-desc">What it is</label><input id="a-desc" value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} />
          <label htmlFor="a-goal">Goal: what it does and how</label><textarea id="a-goal" value={form.goal} onChange={(e) => setForm({ ...form, goal: e.target.value })} style={{ minHeight: 88 }} placeholder="Write test cases from the scenarios. One assertion per case." />
          <div className="sub">No passwords or keys here. Logins are test data, given when the agent is called.</div>
          <label htmlFor="a-plat">Platform</label>
          <select id="a-plat" value={form.platform} onChange={(e) => setForm({ ...form, platform: e.target.value })}><option value="web">Web</option><option value="mobile">Mobile app</option><option value="api">API</option></select>
          <label htmlFor="a-auto">How much it may do alone</label>
          <select id="a-auto" value={form.autonomy} onChange={(e) => setForm({ ...form, autonomy: e.target.value })}><option value="ask-everything">Ask me about everything</option><option value="ask-when-matters">Ask me when it matters</option><option value="run-everything">Run everything it may (risky steps still ask)</option></select>
          <fieldset><legend>Steps it may use</legend>
            {stages.map((s) => <label key={s.id} style={{ display: "flex", gap: 8, alignItems: "center" }}><input type="checkbox" style={{ width: "auto" }} checked={form.stages.includes(s.id)} onChange={() => setForm({ ...form, stages: toggle(form.stages, s.id) })} /> {s.name}</label>)}
          </fieldset>
          <fieldset><legend>Then hands over to (in this order of ticking)</legend>
            {agents.filter((a) => a.name !== form.name).map((a) => <label key={a.name} style={{ display: "flex", gap: 8, alignItems: "center" }}><input type="checkbox" style={{ width: "auto" }} checked={form.then.includes(a.name)} onChange={() => setForm({ ...form, then: toggle(form.then, a.name) })} /> {a.name}</label>)}
            {!agents.length ? <div className="sub">Build the other agents first, then link them here.</div> : null}
          </fieldset>
          <div className="row"><span className="grow" /><Btn onClick={() => setForm(null)}>Cancel</Btn><Btn pri onClick={save}>{editing ? "Save changes" : "Build agent"}</Btn></div>
        </Card>
      ) : null}

      <Card>
        <h2>Call an agent as {me || "yourself"}</h2>
        <div className="sub">You call it through <Link to="/avatar">your own avatar</Link>. The agent does the work; it is recorded as yours, and agents linked after it run in order. {me ? "" : "Enter your name in the box at the bottom of the menu first."}</div>
        <label htmlFor="c-agent">Agent</label>
        <select id="c-agent" value={call.agent} onChange={(e) => setCall({ ...call, agent: e.target.value })}><option value="">Choose…</option>{agents.filter((a) => a.enabled).map((a) => <option key={a.name} value={a.name}>{a.name}{a.then.length ? ` → ${a.then.join(" → ")}` : ""}</option>)}</select>
        <label htmlFor="c-req">Requirement</label><textarea id="c-req" value={call.requirement} onChange={(e) => setCall({ ...call, requirement: e.target.value })} style={{ minHeight: 64 }} />
        <label htmlFor="c-task">This time</label><input id="c-task" value={call.task} onChange={(e) => setCall({ ...call, task: e.target.value })} placeholder="e.g. after release 4.2" />
        <label htmlFor="c-url">App address (optional, your avatar has a default)</label><input id="c-url" value={call.appUrl} onChange={(e) => setCall({ ...call, appUrl: e.target.value })} />
        <div className="row"><span className="grow" /><Btn pri onClick={go} disabled={busy || !call.agent || !me}>{busy ? "Running…" : "Call agent"}</Btn></div>
        {result ? (
          <div role="status">
            <Chip kind={result.ok ? "ok" : "warn"}>{result.ok ? "Done" : "Stopped"}</Chip> <span className="sub">{result.detail}</span>
            {result.chain.map((c) => <div className="row" key={`${c.agent}-${c.runId}`}><b>{c.agent}</b>{c.runId ? <Link to={`/runs/${c.runId}`}>{c.runId}</Link> : <span className="sub">{c.error}</span>}{c.needsYou.length ? <Chip kind="warn">needs you: {c.needsYou.join(", ")}</Chip> : null}</div>)}
          </div>
        ) : null}
      </Card>
    </div>
  );
}
