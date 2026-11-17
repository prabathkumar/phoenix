import { useEffect, useState } from "react";
import { api, get, post, getUser } from "../api.js";
import { Btn, Card, Chip, ErrorNote } from "../ui.jsx";

/** Plugin layer for testing industry products: pick a product, run a mode. Credentials live on the server, never here. */
export default function PluginLayer() {
  const [list, setList] = useState([]), [err, setErr] = useState(null), [out, setOut] = useState({}), [busy, setBusy] = useState(""), [writes, setWrites] = useState(false);
  useEffect(() => { get("/api/plugins").then((d) => setList(d.plugins)).catch(setErr); }, []);
  async function go(id, mode) {
    setBusy(id + mode); setErr(null);
    try { const r = await post(`/api/plugins/${id}/run`, { mode, allowWrites: writes }); setOut((o) => ({ ...o, [id]: { mode, r } })); } catch (e) { setErr(e); } finally { setBusy(""); }
  }
  return (
    <div className="page">
      <div><h1>Plugin layer</h1><div className="sub">Testing industry products. Each product has a plugin; the plugin carries its sign-in, objects, test data and the product versions it supports. When the product upgrades, the plugin is upgraded too.</div></div>
      <ErrorNote error={err} />
      {!getUser() ? <div className="err" role="alert">Say who you are first (top of the page).</div> : null}
      <label><input type="checkbox" checked={writes} onChange={(e) => setWrites(e.target.checked)} /> allow writes (creates and removes tagged test records; use a test system only)</label>
      {list.map((p) => {
        const o = out[p.id], r = o && o.r;
        return (
          <Card key={p.id}>
            <b>{p.name}</b> <Chip kind="mut">{p.family}</Chip> <Chip kind={p.ready ? "ok" : "mut"}>{p.ready ? "set up" : "not set up"}</Chip> <Chip kind="mut">plugin {p.pluginVersion}{p.supports ? ` · product ${p.supports[0]}–${p.supports[1]}` : ""}</Chip> {p.readOnly ? <Chip kind="mut">read-only</Chip> : null}
            {!p.ready ? <div className="sub">Missing on the server: {p.missing.join(", ")}</div> : null}
            <div className="sub">{p.entities.join(", ")}</div>
            <div className="row" style={{ flexWrap: "wrap" }}>
              {["plan", "functional", "readback", "security", "perf"].map((m) => <Btn key={m} onClick={() => go(p.id, m)} disabled={!getUser() || busy === p.id + m || (m !== "plan" && !p.ready)}>{m}</Btn>)}
            </div>
            {r ? <div role="status">
              <b>{o.mode}:</b> {r.unavailable ? "unavailable" : r.ok ? "ok" : "failed"} — {r.detail}
              {r.stale ? <Chip kind="bad">plugin out of date for this product</Chip> : null}
              {r.product ? <div className="sub">Product {r.product.version || "version not read"} · plugin {r.product.plugin} · {r.product.compat}</div> : null}
              <details><summary>Details</summary><pre style={{ overflow: "auto" }}>{JSON.stringify(r.data, null, 2)}</pre></details>
            </div> : null}
          </Card>
        );
      })}
    </div>
  );
}
