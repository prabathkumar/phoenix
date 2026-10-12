/**
 * Turns "this element" into the most stable, verified selector. Shared by the
 * recorder (tester clicked a point) and the Semantic/AI layers (a model picked
 * an element): one rule for what a good locator is.
 */
const { ELEMENT_AT_POINT, buildWebSelectorCandidates } = require("./dom-resolver");

/** Locator for ALL matches of a candidate (no nth/first applied). */
function allMatches(page, sel) {
  switch (sel.strategy) {
    case "css": return page.locator(sel.value);
    case "text": return page.getByText(sel.value, { exact: false });
    case "label": return page.getByLabel(sel.value);
    case "testid": return page.getByTestId(sel.value);
    case "role": return page.getByRole(sel.role, { name: sel.value, exact: sel.exact === true });
    default: return page.locator(sel.value);
  }
}

/**
 * Candidates are tried best-first against the live page (the element carries a
 * data-tm-target marker from ELEMENT_AT_POINT). A unique match wins; a
 * non-unique one is pinned with `nth`; a positional css path is only used when
 * no semantic locator matched at all (and is flagged fragile).
 */
async function resolveSelector(page, descriptor) {
  const candidates = buildWebSelectorCandidates(descriptor);
  if (!candidates.length) return { selector: null, fragile: true };
  try {
    let bestPinned = null;
    for (let i = 0; i < candidates.length; i += 1) {
      const cand = candidates[i];
      if (i === candidates.length - 1 && bestPinned) break;
      const loc = allMatches(page, cand);
      const info = await loc.evaluateAll((els) => ({ count: els.length, index: els.findIndex((e) => e.hasAttribute("data-tm-target")) })).catch(() => null);
      if (!info || info.index < 0) continue;
      if (info.count === 1) return { selector: cand, fragile: i === candidates.length - 1 };
      if (!bestPinned || info.count < bestPinned.count) bestPinned = { cand, count: info.count, index: info.index };
    }
    return bestPinned
      ? { selector: { ...bestPinned.cand, nth: bestPinned.index }, fragile: false }
      : { selector: candidates[candidates.length - 1], fragile: true };
  } finally {
    await page.evaluate(() => document.querySelectorAll("[data-tm-target]").forEach((n) => n.removeAttribute("data-tm-target"))).catch(() => {});
  }
}

/** Describe + locate whatever is at a CSS-pixel point. */
async function resolveSelectorAtPoint(page, point) {
  const descriptor = await page.evaluate(ELEMENT_AT_POINT, point);
  if (!descriptor) return { descriptor: null, selector: null, fragile: true };
  const { selector, fragile } = await resolveSelector(page, descriptor);
  return { descriptor, selector, fragile };
}

module.exports = { allMatches, resolveSelector, resolveSelectorAtPoint };
