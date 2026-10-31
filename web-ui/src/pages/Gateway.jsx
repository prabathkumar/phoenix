import { useState } from "react";
import { api } from "../api.js";
import { Btn, Card, Chip, ErrorNote, useLoad } from "../ui.jsx";

export default function Gateway() {
  const [tab, setTab] = useState("prompts");
  return (
    <div className="page">
      <div><h1>AI Gateway</h1><div className="sub">Every prompt is stored and versioned here. Guardrails and MCP tools are set per prompt. Every model call is logged without its text.</div></div>
      <div className="row">{["prompts", "guardrails", "mcp", "logs"].map((t) => <button key={t} className={`chip ${tab === t ? "info" : "mut"}`} onClick={() => setTab(t)}>{{ prompts: "Prompts", guardrails: "Guardrails", mcp: "MCP servers", logs: "Call log" }[t]}</button>)}</div>
      {tab === "prompts" ? <Prompts /> : tab === "guardrails" ? <Guardrails /> : tab === "mcp" ? <Mcp /> : <Logs />}
    </div>
  );
}

function Prompts() {
  const list = useLoad(() => api.prompts());
  const [sel, setSel] = useState(null);
  const [rec, setRec] = useState(null);
  const [text, setText] = useState("");
  const [note, setNote] = useState("");
  const [err, setErr] = useState(null);
  async function open(p) { setErr(null); try { const r = (await api.prompt(p.name, p.platform)).prompt; setSel(p); setRec(r); setText((r.versions.find((v) => v.v === r.published) || {}).text || ""); } catch (e) { setErr(e); } }
  async function save() { try { const r = (await api.savePrompt({ name: sel.name, platform: sel.platform, text, note, publish: true })).prompt; setRec(r); setNote(""); list.reload(); } catch (e) { setErr(e); } }
  async function pub(v) { try { setRec((await api.publish({ name: sel.name, platform: sel.platform, v })).prompt); list.reload(); } catch (e) { setErr(e); } }
  async function imp() { try { await api.importPrompts(); list.reload(); } catch (e) { setErr(e); } }
  return (
    <div className="grid" style={{ gridTemplateColumns: "minmax(220px,300px) 1fr", alignItems: "start" }}>
      <Card><div className="row"><b className="grow">Prompts</b><Btn onClick={imp}>Import prompts.yaml</Btn></div>
        {(list.data ? list.data.prompts : []).map((p) => <button key={p.name + p.platform} className={`chip ${sel && sel.name === p.name && sel.platform === p.platform ? "info" : "mut"}`} onClick={() => open(p)} style={{ justifyContent: "space-between", width: "100%" }}><span>{p.name}</span><span>{p.platform} · v{p.published}</span></button>)}
        {list.data && !list.data.prompts.length ? <div className="sub">The library is empty. Import prompts.yaml to start.</div> : null}</Card>
      <Card>{rec ? <>
        <div className="row"><b className="grow">{rec.name} · {rec.platform}</b><Chip kind="ok">Published v{rec.published}</Chip></div>
        <label htmlFor="pt">Prompt text (use {"{{name}}"} for variables)</label>
        <textarea id="pt" value={text} onChange={(e) => setText(e.target.value)} style={{ minHeight: 220, fontFamily: "ui-monospace,monospace", fontSize: 12 }} />
        <input aria-label="Version note" value={note} onChange={(e) => setNote(e.target.value)} placeholder="What changed? (optional)" />
        <div className="row"><span className="grow" /><Btn pri onClick={save}>Save as new version and publish</Btn></div>
        <b>Versions</b>
        {[...rec.versions].reverse().map((v) => <div className="row" key={v.v}><Chip kind={v.v === rec.published ? "ok" : "mut"}>v{v.v}</Chip><span className="grow sub">{v.at.slice(0, 16).replace("T", " ")} · {v.by || "unknown"} · {v.note}</span>{v.v !== rec.published ? <Btn onClick={() => pub(v.v)}>Publish this</Btn> : null}</div>)}
      </> : <div className="sub">Pick a prompt to read or edit it. An edit is a new version; nothing is overwritten.</div>}
      <ErrorNote error={err || list.error} /></Card>
    </div>
  );
}

function Guardrails() {
  const { data, error, reload } = useLoad(() => api.guardrails());
  const [err, setErr] = useState(null);
  async function toggle(i) { try { const rules = data.rules.map((r, n) => (n === i ? { ...r, enabled: r.enabled === false } : r)); await api.saveGuardrails(rules); reload(); } catch (e) { setErr(e); } }
  return (
    <Card><b>Rules applied to every model call</b><div className="sub">Block wins over redact over warn. These are pattern checks: they catch the common cases and say what they did.</div>
      <table><thead><tr><th>Rule</th><th>Type</th><th>Applies to</th><th>Action</th><th /></tr></thead><tbody>
        {(data ? data.rules : []).map((r, i) => <tr key={r.id}><td>{r.id}</td><td>{r.type}</td><td>{r.applies}</td><td><Chip kind={r.action === "block" ? "bad" : r.action === "redact" ? "info" : "warn"}>{r.action}</Chip></td><td><Btn onClick={() => toggle(i)}>{r.enabled === false ? "Turn on" : "Turn off"}</Btn></td></tr>)}</tbody></table>
      <ErrorNote error={err || error} /></Card>
  );
}

function Mcp() {
  const { data, error, reload } = useLoad(() => api.mcp());
  const [f, setF] = useState({ id: "", url: "" });
  const [err, setErr] = useState(null);
  const act = (a, b) => async () => { setErr(null); try { await api.mcpAction(a, b); reload(); } catch (e) { setErr(e); } };
  return (
    <Card><b>MCP servers</b><div className="sub">A prompt can only use the tools you allow on it. Header values are stored but never shown again.</div>
      {(data ? data.servers : []).map((s) => <div className="stage" key={s.id}><Chip kind={s.enabled ? "ok" : "mut"}>{s.enabled ? "On" : "Off"}</Chip><div className="grow"><b>{s.id}</b><div className="sub">{s.url} · {s.tools.length} tool(s){s.headers.length ? ` · headers: ${s.headers.join(", ")}` : ""}</div></div><Btn onClick={act("refresh", { id: s.id })}>Get tools</Btn><Btn onClick={act("enable", { id: s.id, enabled: !s.enabled })}>{s.enabled ? "Turn off" : "Turn on"}</Btn><Btn onClick={act("remove", { id: s.id })}>Remove</Btn></div>)}
      <div className="row"><input aria-label="Server id" placeholder="id (docs)" value={f.id} onChange={(e) => setF({ ...f, id: e.target.value })} style={{ width: 160 }} /><input aria-label="Server address" placeholder="https://mcp.example.com/rpc" value={f.url} onChange={(e) => setF({ ...f, url: e.target.value })} /><Btn pri onClick={act("add", f)}>Add</Btn></div>
      <ErrorNote error={err || error} /></Card>
  );
}

function Logs() {
  const { data, error } = useLoad(() => api.logs(100));
  return (
    <Card><b>Recent model calls</b><div className="sub">Source: {data ? data.source : "…"}. The log holds ids, models, timings and guardrail hits, never prompts or answers.</div>
      <table><thead><tr><th>When</th><th>Prompt</th><th>Model</th><th>Status</th><th>ms</th><th>Guardrails</th></tr></thead><tbody>
        {(data ? data.calls : []).map((c, i) => <tr key={i}><td className="sub">{String(c.at).slice(11, 19)}</td><td>{c.name}<div className="sub">{c.prompt}</div></td><td>{c.model || "–"}{c.fell_back ? <span className="sub"> (fallback)</span> : null}</td><td><Chip kind={c.status === "ok" ? "ok" : c.status === "tool" ? "info" : "bad"}>{c.status}</Chip></td><td>{c.ms}</td><td className="sub">{(c.hits || []).join(", ")}</td></tr>)}</tbody></table>
      <ErrorNote error={error} /></Card>
  );
}
