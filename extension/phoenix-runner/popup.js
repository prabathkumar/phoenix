chrome.runtime.sendMessage({ type: "status" }, (s) => { const e = document.getElementById("s"); e.textContent = s ? s.detail : "starting…"; e.className = s && s.connected ? "ok" : "bad"; });
document.getElementById("o").onclick = () => chrome.runtime.openOptionsPage();
