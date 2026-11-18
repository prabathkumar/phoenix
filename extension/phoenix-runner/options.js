const $ = (id) => document.getElementById(id);
async function show() {
  const c = await chrome.storage.local.get(["server", "token", "allow", "enabled"]);
  $("paired").hidden = !c.token; $("form").hidden = !!c.token;
  if (c.token) { $("allow").textContent = (c.allow || []).join(", "); $("off").textContent = c.enabled === false ? "Switch on" : "Switch off"; chrome.runtime.sendMessage({ type: "status" }, (s) => { $("status").textContent = s ? s.detail : "starting…"; $("status").className = s && s.connected ? "ok" : "bad"; }); }
}
$("pair").onclick = async () => {
  const server = $("server").value.trim().replace(/\/$/, ""), code = $("code").value.trim();
  const say = (t, bad) => { $("msg").textContent = t; $("msg").className = bad ? "bad" : "ok"; };
  if (!/^https:\/\//.test(server) && !/^http:\/\/(localhost|127\.0\.0\.1)/.test(server)) return say("The Phoenix address must start with https://", true);
  if (!code) return say("Enter the pairing code", true);
  const origin = new URL(server).origin + "/*";
  if (!(await chrome.permissions.request({ origins: [origin] }))) return say("Chrome needs your OK to reach Phoenix", true);
  try {
    const r = await fetch(server + "/api/runners/register", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ code, name: "Chrome on " + (navigator.platform || "computer"), os: "chrome-extension" }) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) return say(j.detail || `pairing refused (${r.status})`, true);
    await chrome.storage.local.set({ server, token: j.token, runnerId: j.runnerId, allow: j.allow, enabled: true });
    chrome.runtime.sendMessage({ type: "reload" }, () => setTimeout(show, 800)); say("Paired.");
  } catch (e) { say("Could not reach Phoenix: " + e.message, true); }
};
$("off").onclick = async () => { const c = await chrome.storage.local.get("enabled"); await chrome.storage.local.set({ enabled: c.enabled === false }); chrome.runtime.sendMessage({ type: "reload" }, () => setTimeout(show, 500)); };
$("forget").onclick = async () => { await chrome.storage.local.clear(); chrome.runtime.sendMessage({ type: "reload" }, show); };
show();
