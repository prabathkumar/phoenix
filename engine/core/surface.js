/**
 * Surface: the one thing the Semantic and AI layers talk to.
 *
 * A surface is "a screen the tester can see and act on" - a Playwright page
 * today, an Appium session later. The Semantic resolver, the goal loop and the
 * ladder are written once against this contract, so they work on web now and
 * on mobile the day an Appium adapter implements it (the hardware-proven
 * Appium code is not rewritten blind; it is migrated behind tests later).
 *
 *   platform                       "web" | "android" | "ios"
 *   url()                          current page URL ("" when not applicable)
 *   snapshot()                     [{ref, role, name, tag, type?, editable, disabled,
 *                                    id?, testid?, placeholder?, inViewport, x, y}]
 *                                  Refs are valid until the next snapshot().
 *   lines()                        visible text lines (for page diffs)
 *   screenshot()                   base64 image (no data: prefix) for the vision add-on
 *   perform(action)                {ok:true} | {ok:false, reason}
 *       action: {kind:"tap"|"type"|"select"|"press"|"scroll"|"navigate",
 *                ref? | selector?, text?, option?, key?, direction?, url?}
 *   selectorFor(ref)               {selector, fragile} - the most stable locator for that
 *                                  element, in the format the Synthetic layer replays.
 */
const REQUIRED = ["url", "snapshot", "lines", "screenshot", "perform", "selectorFor"];

function assertSurface(surface) {
  if (!surface || typeof surface !== "object") throw new Error("surface is required");
  if (typeof surface.platform !== "string") throw new Error("surface.platform is required");
  for (const m of REQUIRED) {
    if (typeof surface[m] !== "function") throw new Error(`surface.${m}() is required`);
  }
  return surface;
}

/** Visible-line diff, the shared notion of "what changed on screen". */
function diffLines(before, after) {
  const b = new Set(before);
  const a = new Set(after);
  return {
    appeared: after.filter((l) => !b.has(l)),
    disappeared: before.filter((l) => !a.has(l)),
  };
}

module.exports = { assertSurface, diffLines, REQUIRED };
