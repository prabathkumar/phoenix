import { useEffect, useState } from "react";
import { api, getUser } from "../api.js";
import { Btn, Card, Chip, ErrorNote } from "../ui.jsx";

/** Notification settings. Secrets are write-only: the screen shows "set" and never the value. Blank keeps what is saved; "Clear" removes it. */
export default function Notifications() {
  const [data, setData] = useState(null), [err, setErr] = useState(null), [edit, setEdit] = useState({}), [msg, setMsg] = useState("");
  const [routes, setRoutes] = useState({}), [log, setLog] = useState([]), [me, setMe] = useState(null), [busy, setBusy] = useState("");
  async function load() {
    try {
      const [s, c, l] = await Promise.all([api.notifySettings(), api.notifyChannels(), api.notifyLog()]);
      setData(s); setRoutes(c.routes || {}); setLog(l.deliveries || []);
      try { setMe(await api.notifyMe()); } catch { setMe(null); }
      setErr(null);
    } catch (e) { setErr(e); }
  }
  useEffect(() => { load(); }, []);
  const set = (k, v) => setEdit((o) => ({ ...o, [k]: v }));

  async function save() {
    setBusy("save"); setMsg(""); setErr(null);
    try { const r = await api.saveNotifySettings(edit); setEdit({}); setMsg(r.changed.length ? `Saved: ${r.changed.join(", ")}` : "Nothing changed."); await load(); }
    catch (e) { setErr(e); } finally { setBusy(""); }
  }
  async function test(channel) {
    setBusy(channel); setMsg("");
    try { const r = await api.notifyTest({ channel }); setMsg(`Test to ${channel}: ${JSON.stringify(r.results || r)}`); await load(); }
    catch (e) { setErr(e); } finally { setBusy(""); }
  }
  async function saveRoutes() {
    try { await api.saveNotifyRoutes(routes); setMsg("Routes saved."); } catch (e) { setErr(e); }
  }
  const toggleEvent = (ch, ev) => setRoutes((r) => {
    const cur = r[ch] || { events: [], min: "info" }, has = cur.events.includes(ev);
    return { ...r, [ch]: { ...cur, events: has ? cur.events.filter((x) => x !== ev) : [...cur.events, ev] } };
  });

  if (!data) return <div className="page"><h1>Notifications</h1><ErrorNote error={err} /></div>;
  const active = new Set(data.channels || []);
  return (
    <div className="page">
      <div><h1>Notifications</h1><div className="sub">Where Phoenix tells people about defects, failed executions and scans. Saved here, they override the server's environment values.</div></div>
      <ErrorNote error={err} />
      {!getUser() ? <div className="err" role="alert">Say who you are first (top of the page).</div> : null}
      {!data.canEdit ? <div className="sub" role="status">You can look but not change these: only a Phoenix administrator can{data.admins ? "" : " (none is set: add PHOENIX_ADMINS on the server)"}.</div> : null}
      {!data.canStoreSecrets ? <div className="sub" role="status">Tokens and webhook addresses cannot be saved until PHOENIX_SETTINGS_KEY is set on the server (16+ characters). Plain settings can.</div> : null}
      {data.sections.map((s) => (
        <Card key={s.id}>
          <b>{s.name}</b>
          <div className="grid" style={{ gridTemplateColumns: "repeat(auto-fit,minmax(260px,1fr))" }}>
            {s.fields.map((f) => (
              <label key={f.key} style={{ display: "block" }}>
                <span>{f.label}</span> {f.secret ? <Chip kind={f.set ? "ok" : "mut"}>{f.set ? "set" : "not set"}</Chip> : null}{f.source ? <Chip kind="mut">{f.source}</Chip> : null}
                {f.kind === "select" ? (
                  <select disabled={!data.canEdit} value={edit[f.key] ?? f.value ?? ""} onChange={(e) => set(f.key, e.target.value)}>{f.options.map((o) => <option key={o} value={o}>{o || "(off)"}</option>)}</select>
                ) : (
                  <input disabled={!data.canEdit} type={f.secret ? "password" : "text"} autoComplete="off" placeholder={f.secret ? (f.set ? "leave blank to keep" : "") : ""}
                    value={edit[f.key] ?? (f.secret ? "" : f.value ?? "")} onChange={(e) => set(f.key, e.target.value)} />
                )}
                {f.help ? <span className="sub">{f.help}</span> : null}
                {f.secret && f.set && data.canEdit ? <Btn onClick={() => set(f.key, "clear")}>Clear</Btn> : null}
              </label>
            ))}
          </div>
        </Card>
      ))}
      <div className="row"><Btn pri onClick={save} disabled={!data.canEdit || busy === "save" || !Object.keys(edit).length}>{busy === "save" ? "Saving…" : "Save settings"}</Btn>{msg ? <span role="status">{msg}</span> : null}</div>

      <Card>
        <b>Channels in use</b>
        <div className="row" style={{ flexWrap: "wrap" }}>
          {(Object.keys(routes).length || active.size) ? [...new Set([...active, ...Object.keys(routes)])].map((ch) => (
            <span key={ch}><Chip kind={active.has(ch) ? "ok" : "mut"}>{ch}</Chip> <Btn onClick={() => test(ch)} disabled={!active.has(ch) || busy === ch}>Test</Btn></span>
          )) : <span className="sub">None yet. Fill in a channel above and save.</span>}
        </div>
      </Card>

      <Card>
        <b>What goes where</b>
        <div className="sub">Tick the events each channel receives, and the lowest level.</div>
        {[...active].map((ch) => (
          <div key={ch} className="row" style={{ flexWrap: "wrap" }}>
            <b style={{ minWidth: 90 }}>{ch}</b>
            {data.events.map((ev) => <label key={ev}><input type="checkbox" checked={!!(routes[ch] && routes[ch].events.includes(ev))} onChange={() => toggleEvent(ch, ev)} /> {ev}</label>)}
            <select value={(routes[ch] && routes[ch].min) || "info"} onChange={(e) => setRoutes((r) => ({ ...r, [ch]: { ...(r[ch] || { events: [] }), min: e.target.value } }))}><option>info</option><option>warn</option><option>error</option></select>
          </div>
        ))}
        <Btn onClick={saveRoutes} disabled={!active.size}>Save routes</Btn>
      </Card>

      {me ? <Card><b>My choices</b><div className="sub">Held about you: {JSON.stringify(me.prefs)}</div>
        <Btn onClick={async () => { await api.eraseNotifyMe(); setMsg("Your notification data was erased."); load(); }}>Erase my data</Btn></Card> : null}

      <Card><b>Recent deliveries</b>
        {log.length ? <table><thead><tr><th>When</th><th>Event</th><th>Channel</th><th>Result</th></tr></thead><tbody>
          {log.slice(0, 30).map((d, i) => <tr key={i}><td>{new Date((d.at || d.ts || 0) * (d.at > 1e12 ? 1 : 1000)).toLocaleString()}</td><td>{d.event}</td><td>{d.channel}</td><td>{d.ok ? "sent" : `failed: ${d.detail || d.error || ""}`}</td></tr>)}
        </tbody></table> : <div className="sub">Nothing sent yet.</div>}
      </Card>
    </div>
  );
}
