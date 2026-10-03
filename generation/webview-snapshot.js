/**
 * WebView DOM snapshot -- the WebView-side counterpart to
 * semantic-snapshot.js's buildGroundedSnapshot(), same ref-indexed-text
 * contract, different source: a real DOM (collected from a live
 * Appium WebView context via engine/webview-context.js) instead of a
 * native accessibility tree. This is the "Playwright-style
 * accessibility-snapshot approach" discussed for hybrid/React/Flutter
 * web content -- not a fork of Playwright itself (there is no Chromium
 * to drive here, Appium's own WebView bridge already gives real DOM
 * access over the same WebDriver connection every native step already
 * uses), just the same idea: turn the page into a compact, numbered
 * list of interactive elements an LLM can read and choose from, never
 * raw HTML.
 *
 * The actual DOM collection (`SERIALIZE_DOM_SCRIPT` below) runs via
 * `driver.execute()` INSIDE the WebView context -- this module only
 * shapes whatever that script returns into the same snapshot/selector
 * contract generation/semantic-act.js already uses, so
 * engine/semantic-act-executor.js can treat a WebView resolution and a
 * native one identically once a selector comes back.
 */

/**
 * @typedef {Object} WebviewSnapshotElement
 * @property {number} ref
 * @property {string} tag - lowercase tag name, e.g. "button", "input".
 * @property {string} [role] - an explicit role="..." attribute, if any.
 * @property {string} [text] - visible text/value, truncated.
 * @property {string} [ariaLabel]
 * @property {string} [id]
 * @property {string} [name]
 * @property {string} [placeholder]
 * @property {string} [type] - an <input>'s type="..." attribute.
 */

// Executed inside the WebView via driver.execute() -- plain, dependency-
// free JS since it runs in the page's own browsing context, not Node.
// Deliberately narrow to elements a tap/type instruction could plausibly
// target (same reasoning as semantic-snapshot.js's own candidate
// filtering): interactive tags, explicit roles, or anything with a click
// handler/tabindex, capped at 300 so a large page doesn't blow out the
// prompt the same way an uncapped native tree wouldn't either.
const SERIALIZE_DOM_SCRIPT = function serializePhoenixWebviewDom() {
  var nodes = Array.prototype.slice.call(
    document.querySelectorAll(
      'a,button,input,select,textarea,[role],[onclick],[tabindex]'
    )
  );
  var out = [];
  for (var i = 0; i < nodes.length && out.length < 300; i++) {
    var el = nodes[i];
    var rect = el.getBoundingClientRect();
    var visible = !!(rect.width || rect.height) && window.getComputedStyle(el).visibility !== "hidden";
    if (!visible) continue;
    var text = (el.innerText || el.value || "").trim();
    out.push({
      tag: el.tagName.toLowerCase(),
      role: el.getAttribute("role") || undefined,
      text: text ? text.slice(0, 100) : undefined,
      ariaLabel: el.getAttribute("aria-label") || undefined,
      id: el.id || undefined,
      name: el.getAttribute("name") || undefined,
      placeholder: el.getAttribute("placeholder") || undefined,
      type: el.getAttribute("type") || undefined,
    });
  }
  return out;
};

/**
 * Shapes a raw DOM-collection result (whatever SERIALIZE_DOM_SCRIPT
 * returned from the live page) into ref-indexed snapshot elements.
 * Never throws -- a malformed/empty result just produces an empty
 * snapshot, same fail-safe contract as the rest of this layer.
 *
 * @param {Array<Object>} rawElements
 * @returns {WebviewSnapshotElement[]}
 */
function buildWebviewSnapshot(rawElements) {
  if (!Array.isArray(rawElements)) return [];
  return rawElements.map((el, i) => ({
    ref: i,
    tag: typeof el.tag === "string" ? el.tag : "div",
    role: el.role || undefined,
    text: el.text || undefined,
    ariaLabel: el.ariaLabel || undefined,
    id: el.id || undefined,
    name: el.name || undefined,
    placeholder: el.placeholder || undefined,
    type: el.type || undefined,
  }));
}

/**
 * Renders a snapshot into the same kind of compact, numbered text block
 * semantic-snapshot.js's snapshotToText() produces, so the LLM prompt
 * shape is identical regardless of which resolver built it.
 *
 * @param {WebviewSnapshotElement[]} elements
 * @returns {string}
 */
function webviewSnapshotToText(elements) {
  return elements
    .map((el) => {
      const bits = [];
      if (el.id) bits.push(`id: ${el.id}`);
      if (el.name) bits.push(`name: ${el.name}`);
      if (el.ariaLabel) bits.push(`aria-label: ${el.ariaLabel}`);
      if (el.placeholder) bits.push(`placeholder: ${el.placeholder}`);
      if (el.type) bits.push(`type: ${el.type}`);
      const role = el.role || el.tag;
      const label = el.text || el.ariaLabel || el.placeholder;
      const labelPart = label ? ` "${label}"` : "";
      const idsPart = bits.length > 0 ? ` (${bits.join(", ")})` : "";
      return `[${el.ref}] ${role}${labelPart}${idsPart}`;
    })
    .join("\n");
}

function findByRef(elements, ref) {
  return elements.find((el) => el.ref === ref) || null;
}

/**
 * Builds a plain CSS selector for a snapshot element -- the WebView
 * equivalent of semantic-act.js's toSelector(), same priority-order
 * idea (a stable identifier first, a fragile one last), but there is no
 * "last resort" coordinate/xpath fallback here: a DOM element with none
 * of these attributes genuinely has no stable way to address it from
 * outside the page, and guessing a brittle nth-child path would violate
 * the same "never guess" contract as everywhere else in this layer --
 * returning null and letting the caller decline is the honest answer.
 *
 * @param {WebviewSnapshotElement} element
 * @returns {string|null}
 */
function buildCssSelector(element) {
  if (!element) return null;
  if (element.id) return `#${cssEscape(element.id)}`;
  if (element.name) return `${element.tag}[name="${cssEscapeAttr(element.name)}"]`;
  if (element.ariaLabel) return `${element.tag}[aria-label="${cssEscapeAttr(element.ariaLabel)}"]`;
  if (element.placeholder) return `${element.tag}[placeholder="${cssEscapeAttr(element.placeholder)}"]`;
  return null;
}

// Minimal escaping -- good enough for the real-world ids/names/labels
// this has actually been exercised against so far (none yet on real
// hardware; see the module header). Not a full CSS.escape() polyfill.
function cssEscape(value) {
  return String(value).replace(/([^a-zA-Z0-9_-])/g, "\\$1");
}
function cssEscapeAttr(value) {
  return String(value).replace(/"/g, '\\"');
}

module.exports = {
  SERIALIZE_DOM_SCRIPT,
  buildWebviewSnapshot,
  webviewSnapshotToText,
  findByRef,
  buildCssSelector,
};
