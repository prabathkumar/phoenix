import { useEffect, useState } from "react";
import { api, getUser } from "../api.js";
import { Btn, Card, ErrorNote, useLoad } from "../ui.jsx";

const BLANK = { displayName: "", style: "", agents: [], defaults: { project: "", appUrl: "", autonomy: "", web: { url: "" }, mobile: { platform: "", appUrl: "", device: "" } } };

export default function Avatar() {
  const me = getUser();
  const { data, error } = useLoad(() => (me ? api.avatar(me) : Promise.resolve({ avatar: null })), [me]);
  const list = useLoad(() => api.agents());
  const [f, setF] = useState(BLANK);
  const [err, setErr] = useState(null);
  const [saved, setSaved] = useState(false);
  useEffect(() => {
    const a = data && data.avatar;
    if (a) setF({ ...BLANK, ...a, defaults: { ...BLANK.defaults, ...a.defaults, web: { ...BLANK.defaults.web, ...(a.defaults || {}).web }, mobile: { ...BLANK.defaults.mobile, ...(a.defaults || {}).mobile } } });
    else if (data && me) setF({ ...BLANK, displayName: me });
  }, [data, me]);
  const set = (k, v) => { setSaved(false); setF({ ...f, [k]: v }); };
  const dflt = (k, v) => { setSaved(false); setF({ ...f, defaults: { ...f.defaults, [k]: v } }); };
  const nest = (b, k, v) => { setSaved(false); setF({ ...f, defaults: { ...f.defaults, [b]: { ...f.defaults[b], [k]: v } } }); };
  async function save() {
    setErr(null);
    try { await api.saveAvatar(me, f); setSaved(true); } catch (e) { setErr(e); }
  }
  const all = list.data ? list.data.agents : [];
  if (!me) return <div className="page"><h1>My avatar</h1><Card hi>Enter your name in the box at the bottom of the menu. Your avatar belongs to you, so Phoenix needs to know who you are.</Card></div>;
  return (
    <div className="page">
      <div className="sub">AI / Agents</div><h1>My avatar</h1>
      <Card hi>
        <b>You, working through agents</b>
        <div className="sub">When you call an agent, it does the work as your avatar: it uses your defaults and your style, the results are recorded as yours, and sign-off requests go out in your name. Only you can edit or call your avatar. Your avatar can make a run more careful than an agent asks, never less.</div>
      </Card>
      <ErrorNote error={err || error} />
      <Card>
        <label htmlFor="v-name">Name shown</label><input id="v-name" value={f.displayName} onChange={(e) => set("displayName", e.target.value)} />
        <label htmlFor="v-style">How you like things done</label>
        <textarea id="v-style" value={f.style} onChange={(e) => set("style", e.target.value)} style={{ minHeight: 72 }} placeholder="Short steps, one assertion per case, name cases by the user goal." />
        <div className="sub">Added to every agent's goal when you call it. No passwords or keys.</div>
        <label htmlFor="v-proj">Default project</label><input id="v-proj" value={f.defaults.project || ""} onChange={(e) => dflt("project", e.target.value)} />
        <label htmlFor="v-url">Default app address</label><input id="v-url" value={f.defaults.appUrl || ""} onChange={(e) => dflt("appUrl", e.target.value)} />
        <label htmlFor="v-web">Web test address</label><input id="v-web" value={f.defaults.web.url || ""} onChange={(e) => nest("web", "url", e.target.value)} />
        <label htmlFor="v-mp">Mobile platform</label>
        <select id="v-mp" value={f.defaults.mobile.platform || ""} onChange={(e) => nest("mobile", "platform", e.target.value)}><option value="">Not set</option><option value="android">Android</option><option value="ios">iOS</option></select>
        <label htmlFor="v-ma">Mobile app (.apk / .ipa address)</label><input id="v-ma" value={f.defaults.mobile.appUrl || ""} onChange={(e) => nest("mobile", "appUrl", e.target.value)} />
        <label htmlFor="v-md">Device</label><input id="v-md" value={f.defaults.mobile.device || ""} onChange={(e) => nest("mobile", "device", e.target.value)} />
        <label htmlFor="v-auto">Be more careful than the agent</label>
        <select id="v-auto" value={f.defaults.autonomy || ""} onChange={(e) => dflt("autonomy", e.target.value)}><option value="">Follow the agent</option><option value="ask-everything">Always ask me about everything</option><option value="ask-when-matters">Ask me when it matters</option></select>
        <fieldset><legend>Agents I may call (none ticked = all)</legend>
          {all.map((a) => <label key={a.name} style={{ display: "flex", gap: 8, alignItems: "center" }}><input type="checkbox" style={{ width: "auto" }} checked={f.agents.includes(a.name)} onChange={() => set("agents", f.agents.includes(a.name) ? f.agents.filter((x) => x !== a.name) : [...f.agents, a.name])} /> {a.name}</label>)}
        </fieldset>
        <div className="row"><span className="grow" />{saved ? <span className="sub" role="status">Saved</span> : null}<Btn pri onClick={save}>Save my avatar</Btn></div>
      </Card>
    </div>
  );
}
