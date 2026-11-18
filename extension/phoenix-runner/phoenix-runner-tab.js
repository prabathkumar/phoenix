// Phoenix Runner tab: drop it into any extension page (popup tab, options page). Classic script, no inline code, no dependencies.
//   <div id="phoenix-runner"></div> <script src="phoenix-runner-tab.js"></script> <script>PhoenixRunnerTab.mount(document.getElementById("phoenix-runner"))</script>   (use a .js file for the last line: extension pages block inline scripts)
// It stores only under the storage key "phoenixRunner" and talks only in "phoenixRunner:*" messages.
(function () {
  const KEY = "phoenixRunner";
  const el = (tag, props, ...kids) => { const n = Object.assign(document.createElement(tag), props || {}); kids.forEach((k) => n.append(k)); return n; };
  const get = async () => (await chrome.storage.local.get(KEY))[KEY] || {};
  const put = async (patch) => chrome.storage.local.set({ [KEY]: { ...(await get()), ...patch } });

  async function mount(root) {
    const style = el("style", { textContent: ".pr-box{font:14px/1.5 system-ui,sans-serif;color:#1a1a1a}.pr-box input{width:100%;box-sizing:border-box;font:inherit;padding:7px 9px;margin:3px 0 8px}.pr-box button{font:inherit;padding:7px 12px;margin:2px 4px 2px 0;cursor:pointer}.pr-ok{color:#0a7a2f}.pr-bad{color:#b00020}.pr-small{color:#555;font-size:12px}" });
    const box = el("div", { className: "pr-box" });
    root.append(style, box);

    async function draw() {
      const c = await get();
      box.replaceChildren();
      box.append(el("h3", { textContent: "Phoenix Runner", style: "margin:0 0 6px" }));
      if (c.token) {
        const st = el("b", { textContent: "checking…" });
        chrome.runtime.sendMessage({ type: "phoenixRunner:status" }, (s) => { st.textContent = s ? s.detail : "starting…"; st.className = s && s.connected ? "pr-ok" : "pr-bad"; });
        box.append(el("p", {}, "Status: ", st), el("p", { className: "pr-small", textContent: "It may open: " + (c.allow || []).join(", ") }),
          el("button", { textContent: c.enabled === false ? "Switch on" : "Switch off", onclick: async () => { await put({ enabled: c.enabled === false }); setTimeout(draw, 600); } }),
          el("button", { textContent: "Forget this pairing", onclick: async () => { await chrome.storage.local.remove(KEY); draw(); } }));
        return;
      }
      const server = el("input", { placeholder: "https://phoenix.yourcompany.com", value: c.server || "" }), code = el("input", { placeholder: "Pairing code, e.g. 3E5C-92E1", autocomplete: "off" }), msg = el("p", { className: "pr-small", role: "status" });
      const say = (t, bad) => { msg.textContent = t; msg.className = bad ? "pr-bad" : "pr-ok"; };
      box.append(el("p", { className: "pr-small", textContent: "Lets Phoenix use this Chrome for live test sessions on intranet and VPN apps. This Chrome connects out to Phoenix; nothing is opened into your network." }),
        el("label", { textContent: "Phoenix address" }), server, el("label", { textContent: "Pairing code (Phoenix > Laptop runners > Get a pairing code)" }), code,
        el("button", { textContent: "Pair", onclick: async () => {
          const s = server.value.trim().replace(/\/$/, ""), cd = code.value.trim();
          if (!/^https:\/\//.test(s) && !/^http:\/\/(localhost|127\.0\.0\.1)/.test(s)) return say("The Phoenix address must start with https://", true);
          if (!cd) return say("Enter the pairing code", true);
          const origins = [new URL(s).origin + "/*"];
          if (!(await chrome.permissions.contains({ origins }))) { say("Chrome will ask to let this extension reach Phoenix. If this window closes, open it again and press Pair."); if (!(await chrome.permissions.request({ origins }))) return say("Chrome needs your OK to reach Phoenix", true); }
          try {
            const r = await fetch(s + "/api/runners/register", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ code: cd, name: "Chrome on " + (navigator.platform || "computer"), os: "chrome-extension" }) });
            const j = await r.json().catch(() => ({}));
            if (!r.ok) return say(j.detail || "pairing refused (" + r.status + ")", true);
            await put({ server: s, token: j.token, runnerId: j.runnerId, allow: j.allow, enabled: true });
            setTimeout(draw, 1000);
          } catch (e) { say("Could not reach Phoenix: " + e.message, true); }
        } }), msg);
    }
    await draw();
  }
  globalThis.PhoenixRunnerTab = { mount };
})();
