/**
 * Runs INSIDE the page. Lists the visible interactive elements with an
 * accessible name, role and a few stable identifiers, and tags each with
 * data-tm-ref so a later action can address exactly that element.
 */
function SNAPSHOT_SCRIPT() {
  var SEL = "a,button,input,select,textarea,summary,label,[role=button],[role=link],[role=checkbox],[role=tab],[role=menuitem],[role=switch],[role=option],[role=radio],[onclick],[tabindex]";
  Array.prototype.forEach.call(document.querySelectorAll("[data-tm-ref]"), function (n) { n.removeAttribute("data-tm-ref"); });
  var firstLine = function (s, n) {
    var line = String(s || "").split("\n").map(function (l) { return l.replace(/\s+/g, " ").trim(); }).filter(Boolean)[0] || "";
    return line.length > n ? line.slice(0, n) : line;
  };
  var out = [];
  var nodes = Array.prototype.slice.call(document.querySelectorAll(SEL));
  for (var i = 0; i < nodes.length && out.length < 250; i++) {
    var el = nodes[i];
    var tag = el.tagName.toLowerCase();
    if (tag === "label" && (el.control || el.querySelector("input,select,textarea"))) continue; // the control is listed itself
    var rect = el.getBoundingClientRect();
    if (!(rect.width > 1 && rect.height > 1)) continue;
    var cs = window.getComputedStyle(el);
    if (cs.visibility === "hidden" || cs.display === "none" || cs.opacity === "0") continue;
    var type = (el.getAttribute("type") || "").toLowerCase();
    var roleAttr = (el.getAttribute("role") || "").toLowerCase();
    var role = roleAttr ||
      (tag === "a" && el.hasAttribute("href") ? "link" :
       tag === "button" || (tag === "input" && ["submit", "button", "reset"].indexOf(type) >= 0) ? "button" :
       tag === "input" && type === "checkbox" ? "checkbox" :
       tag === "input" && type === "radio" ? "radio" :
       tag === "select" ? "combobox" :
       tag === "textarea" || tag === "input" ? "textbox" : tag);
    var labelEl = el.labels && el.labels[0];
    var img = el.querySelector && el.querySelector("img[alt]");
    var name = firstLine(el.getAttribute("aria-label") || (labelEl && labelEl.innerText) || el.innerText || el.getAttribute("placeholder") || (img && img.getAttribute("alt")) || el.getAttribute("title") || el.value, 80);
    var editable = tag === "textarea" || el.isContentEditable ||
      (tag === "input" && ["text", "email", "password", "search", "tel", "url", "number", ""].indexOf(type) >= 0);
    var id = el.id && /^[A-Za-z][\w-]{0,40}$/.test(el.id) && !/\d{3,}/.test(el.id) ? el.id : undefined;
    var ref = out.length;
    el.setAttribute("data-tm-ref", String(ref));
    out.push({
      ref: ref, tag: tag, role: role, name: name, type: type || undefined,
      editable: !!editable, disabled: !!el.disabled || el.getAttribute("aria-disabled") === "true",
      id: id, testid: el.getAttribute("data-testid") || el.getAttribute("data-test") || el.getAttribute("data-qa") || undefined,
      placeholder: el.getAttribute("placeholder") || undefined,
      inViewport: rect.bottom > 0 && rect.right > 0 && rect.top < window.innerHeight && rect.left < window.innerWidth,
      x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2)
    });
  }
  return out;
}

module.exports = { SNAPSHOT_SCRIPT };
