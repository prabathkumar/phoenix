import { useEffect, useRef, useState } from "react";
import { api, getUser } from "../api.js";
import { Btn, Card, Chip, ErrorNote } from "../ui.jsx";

/** The tester sees the real browser (Chromium on the engine, or BrowserStack), clicks and types into it, and can hand a goal to the AI.
 *  Every click and entry is recorded as a step. A value typed as a SECRET is sent to the page but never written into the recorded test or its data. */
export default function LiveBrowser() {
  const [f, setF] = useState({ url: "", runOn: "local" });
  const [state, setState] = useState("idle"), [err, setErr] = useState(null), [frame, setFrame] = useState(null), [page, setPage] = useState({ url: "", title: "" });
  const [steps, setSteps] = useState([]), [ai, setAi] = useState([]), [done, setDone] = useState(null), [msg, setMsg] = useState("");
  const [text, setText] = useState(""), [field, setField] = useState(""), [secret, setSecret] = useState(false), [goal, setGoal] = useState(""), [nav, setNav] = useState("");
  const ws = useRef(null), img = useRef(null);
  const send = (m) => { if (ws.current && ws.current.readyState === 1) ws.current.send(JSON.stringify(m)); };
  useEffect(() => () => { try { ws.current && ws.current.close(); } catch { /* closed */ } }, []);

  async function start() {
    setErr(null); setState("starting"); setSteps([]); setAi([]); setDone(null); setMsg("");
    try {
      const { port } = await api.liveStart({ url: f.url, runOn: f.runOn });
      const sock = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.hostname}:${port}`);
      ws.current = sock;
      sock.onmessage = (e) => {
        let m; try { m = JSON.parse(e.data); } catch { return; }
        if (m.type === "frame") setFrame(`data:${m.mime};base64,${m.screenshotBase64}`);
        else if (m.type === "page") setPage({ url: m.url, title: m.title });
        else if (m.type === "step-recorded") setSteps((s) => [...s.slice(0, m.stepIndex), { kind: m.kind, text: m.instruction }, ...s.slice(m.stepIndex + 1)]);
        else if (m.type === "text-entered") setMsg("Entry recorded.");
        else if (m.type === "step-undone") setSteps((s) => s.slice(0, m.stepCount));
        else if (m.type === "ai-progress") setAi((a) => [...a, m.message]);
        else if (m.type === "ai-finished") { setMsg(`AI finished: ${m.message || (m.success ? "done" : "stopped")} (${m.stepsAdded} step(s) added)`); }
        else if (["action-error", "type-error", "busy"].includes(m.type)) setMsg(m.message);
        else if (m.type === "script-generated") { setDone(m); setState("idle"); }
      };
      sock.onopen = () => setState("live");
      sock.onclose = () => setState((s) => (s === "live" ? "idle" : s));
      sock.onerror = () => { setErr(new Error(`Could not reach the live view on port ${port}. Is that port open to this computer?`)); setState("idle"); };
    } catch (e) { setErr(e); setState("idle"); }
  }
  function tap(e) {
    const r = img.current.getBoundingClientRect();
    send({ type: "tap", xRatio: (e.clientX - r.left) / r.width, yRatio: (e.clientY - r.top) / r.height });
  }
  function enter() {
    send({ type: "type", value: text, ...(secret ? { param: field || "secret_value", secret: true } : field ? { param: field } : {}) });
    setText("");
  }
  const live = state === "live";
  return (
    <div className="page">
      <div><h1>Live browser</h1><div className="sub">See the real browser, click and type into it yourself, or give the AI a goal. Use it for what only a person should enter (a login, a one-time code). Run it on this server or on BrowserStack.</div></div>
      <ErrorNote error={err} />
      {!getUser() ? <div className="err" role="alert">Say who you are first (top of the page), so the session is recorded against you.</div> : null}
      <Card>
        <div className="grid" style={{ gridTemplateColumns: "repeat(auto-fit,minmax(220px,1fr))" }}>
          <input placeholder="https://… (the site to test)" value={f.url} onChange={(e) => setF({ ...f, url: e.target.value })} disabled={live} />
          <select value={f.runOn} onChange={(e) => setF({ ...f, runOn: e.target.value })} disabled={live}><option value="local">Browser on this server</option><option value="browserstack">BrowserStack (uses minutes)</option></select>
        </div>
        <div className="row"><Btn pri onClick={start} disabled={live || state === "starting" || !f.url || !getUser()}>{state === "starting" ? "Opening…" : "Open browser"}</Btn>
          {live ? <Btn onClick={() => send({ type: "stop" })}>Stop and make the test</Btn> : null}{live ? <Chip kind="ok">live</Chip> : null}</div>
      </Card>
      {live || frame ? (
        <Card>
          <div className="sub">{page.title} {page.url}</div>
          {frame ? <img ref={img} src={frame} alt="the live browser" onClick={live ? tap : undefined} style={{ width: "100%", maxWidth: 1280, border: "1px solid var(--line, #ccc)", cursor: live ? "pointer" : "default" }} /> : null}
          {live ? <>
            <div className="row" style={{ flexWrap: "wrap" }}>
              <input placeholder="address" value={nav} onChange={(e) => setNav(e.target.value)} /><Btn onClick={() => { send({ type: "navigate", url: nav }); setNav(""); }} disabled={!nav}>Go</Btn>
              <Btn onClick={() => send({ type: "scroll", direction: "up" })}>Scroll up</Btn><Btn onClick={() => send({ type: "scroll", direction: "down" })}>Scroll down</Btn>
              <Btn onClick={() => send({ type: "press", key: "Enter" })}>Enter</Btn><Btn onClick={() => send({ type: "press", key: "Tab" })}>Tab</Btn><Btn onClick={() => send({ type: "undo" })}>Undo</Btn>
            </div>
            <div className="sub">Click a field in the picture first, then type here.</div>
            <div className="row" style={{ flexWrap: "wrap" }}>
              <input type={secret ? "password" : "text"} placeholder="what to type" value={text} onChange={(e) => setText(e.target.value)} autoComplete="off" />
              <input placeholder="name for this value (optional)" value={field} onChange={(e) => setField(e.target.value)} />
              <label><input type="checkbox" checked={secret} onChange={(e) => setSecret(e.target.checked)} /> secret (a password or code: never saved in the test)</label>
              <Btn pri onClick={enter} disabled={!text}>Type it</Btn>
            </div>
            <div className="row"><input placeholder="or tell the AI what to do, e.g. add the cheapest plan to the cart" value={goal} onChange={(e) => setGoal(e.target.value)} style={{ flex: 1 }} /><Btn onClick={() => { setAi([]); send({ type: "ai-goal", goal }); }} disabled={!goal}>Ask AI</Btn></div>
          </> : null}
          {msg ? <div className="sub" role="status">{msg}</div> : null}
          {ai.length ? <div className="sub">AI: {ai.slice(-3).join(" → ")}</div> : null}
        </Card>
      ) : null}
      {steps.length ? <Card><b>Recorded steps</b><ol>{steps.map((s, i) => <li key={i}>{s.text} <Chip kind="mut">{s.kind}</Chip></li>)}</ol></Card> : null}
      {done ? <Card><b>Test made: {done.testName}</b> <span className="sub">{done.assertionCount} check(s). Typed secrets are left out; supply them as environment values when it runs.</span>
        <details><summary>Test case</summary><pre style={{ overflow: "auto" }}>{JSON.stringify(done.testCaseJson, null, 2)}</pre></details>
        <details><summary>Playwright script</summary><pre style={{ overflow: "auto" }}>{done.scriptSource}</pre></details></Card> : null}
    </div>
  );
}
