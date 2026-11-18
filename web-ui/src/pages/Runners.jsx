import { useEffect, useState } from "react";
import { api, getUser } from "../api.js";
import { Btn, Card, Chip, ErrorNote } from "../ui.jsx";

/** Laptop runners: let Phoenix (in AWS) use a browser on YOUR computer, so intranet and VPN apps can be tested. The laptop connects out; nothing is opened inbound. */
export default function Runners() {
  const [list, setList] = useState([]), [err, setErr] = useState(null), [allow, setAllow] = useState(""), [pair, setPair] = useState(null);
  const load = () => api.runners().then((d) => setList(d.runners)).catch(setErr);
  useEffect(() => { load(); const t = setInterval(load, 10000); return () => clearInterval(t); }, []);
  async function makeCode() {
    setErr(null);
    try { setPair(await api.runnerPair({ allow: allow.split(/[\s,]+/).filter(Boolean), name: "my laptop" })); } catch (e) { setErr(e); }
  }
  const server = location.origin;
  return (
    <div className="page">
      <div><h1>Laptop runners</h1><div className="sub">Use a browser on your own computer (on the VPN or intranet) from Phoenix. The laptop connects out to Phoenix; nothing is opened into your network. It can open only the addresses you allow here.</div></div>
      <ErrorNote error={err} />
      {!getUser() ? <div className="err" role="alert">Say who you are first (your work address, top of the page).</div> : null}
      <Card>
        <b>Add a laptop</b>
        <div className="sub">Addresses this laptop may open, separated by commas: a host (intranet.corp.example.com), a subdomain wildcard (*.corp.example.com) or an IPv4 range (10.20.0.0/16).</div>
        <div className="row"><input style={{ flex: 1 }} placeholder="*.corp.example.com, 10.20.0.0/16" value={allow} onChange={(e) => setAllow(e.target.value)} /><Btn pri onClick={makeCode} disabled={!getUser() || !allow.trim()}>Get a pairing code</Btn></div>
        {pair ? <div role="status">
          <div>Code: <b style={{ fontSize: 22, letterSpacing: 2 }}>{pair.code}</b> <span className="sub">valid for {Math.round(pair.expiresIn / 60)} minutes, one use</span></div>
          <div className="sub">On the laptop, in the Phoenix folder (needs Node 20+ and `cd web && npm install && npx playwright install chromium` once):</div>
          <pre style={{ overflow: "auto" }}>{`node runner/phoenix-runner.js pair ${server} ${pair.code}\nnode runner/phoenix-runner.js start`}</pre>
          <div className="sub">Keep the second command running while you want Phoenix to use this laptop. It may open: {pair.allow.join(", ")}.</div>
        </div> : null}
      </Card>
      <Card>
        <b>Your runners</b>
        {list.length ? <table><thead><tr><th>Name</th><th>Status</th><th>May open</th><th /></tr></thead><tbody>
          {list.map((r) => <tr key={r.id}><td>{r.name} <span className="sub">{r.os}</span></td><td><Chip kind={r.online ? "ok" : "mut"}>{r.online ? "online" : "offline"}</Chip></td><td>{r.allow.join(", ")}</td>
            <td><Btn onClick={async () => { await api.runnerRevoke(r.id); load(); }}>Revoke</Btn></td></tr>)}
        </tbody></table> : <div className="sub">No laptop paired yet.</div>}
        <div className="sub">Then open <b>Live browser</b> and choose <b>My laptop</b>.</div>
      </Card>
    </div>
  );
}
