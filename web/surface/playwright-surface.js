/**
 * Surface (engine/core/surface.js) over a Playwright page.
 */
const { SNAPSHOT_SCRIPT } = require("./snapshot-script");
const { resolveSelectorAtPoint } = require("../recorder/locate");

const VISIBLE_LINES = function () {
  var text = (document.body && document.body.innerText) || "";
  var seen = {}; var out = [];
  text.split("\n").forEach(function (l) { l = l.trim(); if (l && !seen[l]) { seen[l] = true; out.push(l.slice(0, 200)); } });
  return out.slice(0, 500);
};

function createPlaywrightSurface(page, { actionTimeoutMs = 10000, locatorFor } = {}) {
  // Lazy: the runner module requires this file, so it can't be required at load time.
  const locFor = locatorFor || ((p, sel) => require("../web-test-case-runner").locatorFor(p, sel));
  const byRef = (ref) => page.locator(`[data-tm-ref="${Number(ref)}"]`);

  return {
    platform: "web",
    page,
    url: () => page.url(),
    snapshot: async () => page.evaluate(SNAPSHOT_SCRIPT),
    lines: async () => { try { return await page.evaluate(VISIBLE_LINES); } catch { return []; } },
    screenshot: async () => (await page.screenshot({ type: "jpeg", quality: 60 })).toString("base64"),

    async perform(action) {
      try {
        const target = action.ref !== undefined && action.ref !== null ? byRef(action.ref) : action.selector ? locFor(page, action.selector) : null;
        const t = { timeout: actionTimeoutMs };
        switch (action.kind) {
          case "navigate": await page.goto(action.url, { waitUntil: "load", timeout: 30000 }); break;
          case "scroll": await page.mouse.wheel(0, action.direction === "up" ? -600 : 600); break;
          case "press":
            if (target) await target.first().press(action.key, t); else await page.keyboard.press(action.key);
            break;
          case "type": await target.first().fill(String(action.text ?? ""), t); break;
          case "select": await target.first().selectOption({ label: action.option }, t); break;
          case "tap": await target.first().click(t); break;
          default: return { ok: false, reason: `unsupported action "${action.kind}"` };
        }
        try { await page.waitForLoadState("load", { timeout: 3000 }); } catch { /* no navigation */ }
        await page.waitForTimeout(250);
        return { ok: true };
      } catch (err) {
        return { ok: false, reason: String(err.message || err).split("\n")[0] };
      }
    },

    async selectorFor(ref) {
      const loc = byRef(ref).first();
      await loc.scrollIntoViewIfNeeded({ timeout: 2000 }).catch(() => {});
      const point = await loc.evaluate((el) => { const r = el.getBoundingClientRect(); return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }; }).catch(() => null);
      if (!point) return { selector: null, fragile: true };
      const { selector, fragile } = await resolveSelectorAtPoint(page, point);
      return { selector, fragile };
    },
  };
}

module.exports = { createPlaywrightSurface };
