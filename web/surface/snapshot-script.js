/**
 * Runs INSIDE the page. Lists the visible interactive elements with an
 * accessible name, role and a few stable identifiers, and tags each with
 * data-tm-ref so a later action can address exactly that element.
 */
function SNAPSHOT_SCRIPT() {
  var SEL = "a,button,input,select,textarea,summary,label,[role=button],[role=link],[role=checkbox],[role=tab],[role=menuitem],[role=switch],[role=option],[role=radio],[onclick],[tabindex],img,svg,[class*=logo i],[id*=logo i]";
  var logoish = function (el) {
    var t = [el.getAttribute("class"), el.id, el.getAttribute("alt"), el.getAttribute("aria-label"), el.getAttribute("title"), el.getAttribute("src"), el.getAttribute("href")].join(" ");
    if (/logo|brand/i.test(t)) return true;
    var home = el.tagName.toLowerCase() === "a" && /^(\/|\.\/|index\.html?)?$/i.test(el.getAttribute("href") || "x") && el.querySelector && el.querySelector("img,svg") && el.closest && el.closest("header,nav,[role=banner]");
    return !!home;
  };
  Array.prototype.forEach.call(document.querySelectorAll("[data-tm-ref]"), function (n) { n.removeAttribute("data-tm-ref"); });
  // Several controls can share a name (every product card has "Buy now"): say what card/row/section each one sits in.
  var around = function (el, own) {
    var node = el.parentElement, ownLen = String(own || "").length;
    for (var hop = 0; node && node !== document.body && hop < 8; hop++, node = node.parentElement) {
      var t = String(node.innerText || "").replace(/\s+/g, " ").trim();
      if (t.length > ownLen + 25) {
        if (t.length > 420) return "";
        var rest = own ? t.split(own).join(" ").replace(/\s+/g, " ").trim() : t;
        return rest.slice(0, 120);
      }
    }
    return "";
  };
  var firstLine = function (s, n) {
    var line = String(s || "").split("\n").map(function (l) { return l.replace(/\s+/g, " ").trim(); }).filter(Boolean)[0] || "";
    return line.length > n ? line.slice(0, n) : line;
  };
  var out = [];
  var nodes = Array.prototype.slice.call(document.querySelectorAll(SEL));
  // Menus and cards are often plain div/span/li with a script listener: no tag, role or onclick says "clickable", the pointer cursor does.
  var seen = new Set(nodes);
  var extras = document.querySelectorAll("div,span,li,p,h1,h2,h3,h4,h5,h6,b,strong,em,small,td,dt,dd");
  for (var k = 0; k < extras.length && k < 6000; k++) {
    var x = extras[k];
    if (seen.has(x)) continue;
    var xt = String(x.innerText || "").replace(/\s+/g, " ").trim();
    if (!xt || xt.length > 80) continue;
    if (window.getComputedStyle(x).cursor !== "pointer") continue;
    var px = x.parentElement;
    if (px && window.getComputedStyle(px).cursor === "pointer") continue; // the outermost pointer element is the thing to click
    if (x.closest("a,button,[role=button],[role=link],[onclick],[tabindex]")) continue;
    nodes.push(x);
  }
  for (var i = 0; i < nodes.length && out.length < 400; i++) {
    var el = nodes[i];
    var tag = el.tagName.toLowerCase();
    if ((tag === "img" || tag === "svg") && !logoish(el)) continue; // plain pictures are not actions; only logo-like ones are listed
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
    var name = firstLine(el.getAttribute("aria-label") || (labelEl && labelEl.innerText) || el.innerText || el.getAttribute("placeholder") || el.getAttribute("alt") || (img && img.getAttribute("alt")) || el.getAttribute("title") || el.value, 80);
    var isLogo = logoish(el) || !!(el.querySelector && [].slice.call(el.querySelectorAll("img,svg")).some(logoish));
    if (!name && isLogo) name = "logo";
    var editable = tag === "textarea" || el.isContentEditable ||
      (tag === "input" && ["text", "email", "password", "search", "tel", "url", "number", ""].indexOf(type) >= 0);
    var id = el.id && /^[A-Za-z][\w-]{0,40}$/.test(el.id) && !/\d{3,}/.test(el.id) ? el.id : undefined;
    var ref = out.length;
    el.setAttribute("data-tm-ref", String(ref));
    out.push({
      ref: ref, tag: tag, role: role, name: name, type: type || undefined,
      editable: !!editable, disabled: !!el.disabled || el.getAttribute("aria-disabled") === "true",
      hint: isLogo ? "logo" : undefined,
      within: around(el, name) || undefined,
      id: id, testid: el.getAttribute("data-testid") || el.getAttribute("data-test") || el.getAttribute("data-qa") || undefined,
      placeholder: el.getAttribute("placeholder") || undefined,
      inViewport: rect.bottom > 0 && rect.right > 0 && rect.top < window.innerHeight && rect.left < window.innerWidth,
      x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2)
    });
  }
  return out;
}

module.exports = { SNAPSHOT_SCRIPT };
