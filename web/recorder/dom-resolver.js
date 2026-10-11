/**
 * Resolves "what is at this point on the page" into a stable web selector,
 * in the same {strategy, value} contract web/web-test-case-runner.js replays
 * (css | xpath | text | label | testid).
 *
 * Priority (most to least stable): data-testid -> accessible label ->
 * id -> name/placeholder -> visible text -> css path.
 */

/** Runs INSIDE the page. Receives CSS-pixel coordinates. */
function ELEMENT_AT_POINT(point) {
  var INTERACTIVE = "a,button,input,select,textarea,summary,label,[role=button],[role=link],[role=checkbox],[role=tab],[role=menuitem],[role=switch],[role=option],[onclick],[tabindex]";
  var start = document.elementFromPoint(point.x, point.y);
  if (!start) return null;
  var el = start.closest(INTERACTIVE) || start;
  // A <label> wrapping/pointing at a control: act on the control.
  if (el.tagName === "LABEL") {
    var ctl = el.control || el.querySelector("input,select,textarea");
    if (ctl) el = ctl;
  }

  var attr = function (n) { var v = el.getAttribute(n); return v ? v.trim() : ""; };
  var clip = function (s, n) { s = (s || "").replace(/\s+/g, " ").trim(); return s.length > n ? "" : s; };
  var tag = el.tagName.toLowerCase();
  var type = (attr("type") || "").toLowerCase();
  var editable = tag === "textarea" || el.isContentEditable ||
    (tag === "input" && ["text", "email", "password", "search", "tel", "url", "number", ""].indexOf(type) >= 0);

  var labelText = "";
  if (el.labels && el.labels.length) labelText = clip(el.labels[0].innerText, 60);
  var rect = el.getBoundingClientRect();

  // Short, stable-looking ids only (skip framework-generated ones like ":r1:" or "ember123").
  var id = el.id && /^[A-Za-z][\w-]{0,40}$/.test(el.id) && !/\d{3,}/.test(el.id) ? el.id : "";

  function cssPath(node) {
    var parts = [];
    while (node && node.nodeType === 1 && node !== document.documentElement && parts.length < 6) {
      var part = node.tagName.toLowerCase();
      var parent = node.parentElement;
      if (parent) {
        var same = Array.prototype.filter.call(parent.children, function (c) { return c.tagName === node.tagName; });
        if (same.length > 1) part += ":nth-of-type(" + (same.indexOf(node) + 1) + ")";
      }
      parts.unshift(part);
      node = parent;
    }
    return parts.join(" > ");
  }

  return {
    tag: tag,
    type: type,
    editable: editable,
    testid: attr("data-testid") || attr("data-test") || attr("data-cy") || attr("data-qa"),
    id: id,
    ariaLabel: attr("aria-label"),
    labelText: labelText,
    name: attr("name"),
    placeholder: attr("placeholder"),
    text: editable ? "" : clip(el.innerText || el.value || "", 60),
    cssPath: cssPath(el),
    rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
  };
}

/** Same lookup but for whatever currently has keyboard focus. */
function ACTIVE_ELEMENT_POINT() {
  var el = document.activeElement;
  if (!el || el === document.body) return null;
  var r = el.getBoundingClientRect();
  return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
}

function cssEscapeValue(v) {
  return String(v).replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

/** @param {Object} d descriptor returned by ELEMENT_AT_POINT */
function buildWebSelector(d) {
  if (!d) return null;
  if (d.testid) return { strategy: "testid", value: d.testid };
  if (d.ariaLabel) return { strategy: "label", value: d.ariaLabel };
  if (d.labelText) return { strategy: "label", value: d.labelText };
  if (d.id) return { strategy: "css", value: `#${d.id}` };
  if (d.name && (d.editable || d.tag === "select" || d.tag === "input" || d.tag === "button")) {
    return { strategy: "css", value: `${d.tag}[name="${cssEscapeValue(d.name)}"]` };
  }
  if (d.placeholder) return { strategy: "css", value: `${d.tag}[placeholder="${cssEscapeValue(d.placeholder)}"]` };
  if (d.text) return { strategy: "text", value: d.text };
  return { strategy: "css", value: d.cssPath };
}

/** Human-readable description used as the step's `instruction`. */
function describeElement(d, verb = "Click") {
  if (!d) return verb;
  const name = d.ariaLabel || d.labelText || d.text || d.placeholder || d.name || d.id || d.tag;
  const kind = d.tag === "a" ? "link" : d.tag === "button" || d.type === "submit" ? "button" : d.editable ? "field" : d.tag === "select" ? "dropdown" : d.type === "checkbox" ? "checkbox" : "";
  return `${verb} "${name}"${kind ? " " + kind : ""}`;
}

module.exports = { ELEMENT_AT_POINT, ACTIVE_ELEMENT_POINT, buildWebSelector, describeElement };
