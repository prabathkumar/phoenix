/**
 * Deterministic "Check that ..." steps: they read the page, they never click or ask a model.
 *   Check that no error is showing               -> no visible line looks like an error or a stop message
 *   Check that the page says "Order summary"     -> that text is visible
 *   Check that the URL contains /cart            -> the address contains it
 * Without these a journey only proves every tap hit a control, not that the page ended in the right state.
 */
const ERROR_LINE = /(something went wrong|an error (has )?occurred|error code|error \d{3}|page not found|404 not found|service unavailable|access denied|unable to (process|load|continue|proceed)|failed to|please try again|try again later|invalid (number|input|code|value|email)|oops|sold out online|out of stock|stock temporarily reserved|temporarily reserved|currently unavailable|join waitlist)/i;

function parseCheck(goal) {
  const g = String(goal || "").trim().replace(/[.!]+$/, "");
  const lead = "(?:check|verify|confirm|make sure|assert)(?: that)?";
  if (new RegExp(`^${lead} (?:there (?:is|are) |there's )?no (?:error|errors|error message|error messages|problem|problems)(?: (?:is|are))?(?: (?:showing|shown|displayed|visible|on the page))?$`, "i").test(g)) return { kind: "no-error" };
  let m = new RegExp(`^${lead} (?:the )?(?:url|address|page address|page url) (?:contains|includes|has) (.+)$`, "i").exec(g);
  if (m) return { kind: "url", value: m[1].replace(/^["'“”]|["'“”]$/g, "").trim() };
  m = new RegExp(`^${lead} (?:the )?(?:page|screen)(?: (?:now|still))? (?:says|shows|contains|has|is showing|displays) (.+)$`, "i").exec(g);
  if (m) return { kind: "text", value: m[1].replace(/^["'“”]|["'“”]$/g, "").trim() };
  return null;
}

/** Runs one check. Returns {success, reason} or null when the goal is not a deterministic check. */
async function runCheck(surface, goal, { settleMs = 700, tries = 3 } = {}) {
  const c = parseCheck(goal);
  if (!c) return null;
  const read = async () => (await surface.lines()).map((l) => String(l).replace(/\s+/g, " ").trim()).filter(Boolean);
  for (let i = 0; ; i += 1) {
    await new Promise((r) => setTimeout(r, settleMs)); // let the page finish what the last tap started
    let lines; try { lines = await read(); } catch { lines = []; }
    if (c.kind === "no-error") {
      const bad = [...new Set(lines.filter((l) => l.length <= 160 && ERROR_LINE.test(l)))];
      if (!bad.length) return { success: true, reason: "no error or stop message is showing" };
      if (i >= tries - 1) return { success: false, reason: `the page is showing: "${bad.slice(0, 2).join(" / ")}"` };
    } else if (c.kind === "text") {
      const want = c.value.toLowerCase();
      if (lines.some((l) => l.toLowerCase().includes(want))) return { success: true, reason: `the page shows "${c.value}"` };
      if (i >= tries - 1) return { success: false, reason: `the page does not show "${c.value}"` };
    } else {
      let url = ""; try { url = String(surface.url()); } catch { /* none */ }
      if (url.toLowerCase().includes(c.value.toLowerCase())) return { success: true, reason: `the address contains "${c.value}"` };
      if (i >= tries - 1) return { success: false, reason: `the address ${url || "(unknown)"} does not contain "${c.value}"` };
    }
  }
}
module.exports = { parseCheck, runCheck, ERROR_LINE };
