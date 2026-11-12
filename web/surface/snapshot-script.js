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
  // A colour swatch has no text: name it by the colour it shows ("grey colour swatch") so "select the grey colour" can find it.
  var colourName = function (el) {
    var cs0 = window.getComputedStyle(el), bg = cs0.backgroundColor;
    if ((!bg || /rgba\(.*,\s*0\)$|transparent/.test(bg)) && el.firstElementChild) bg = window.getComputedStyle(el.firstElementChild).backgroundColor;
    var m = String(bg || "").match(/rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?/);
    if (!m || (m[4] !== undefined && Number(m[4]) === 0)) return "";
    var r = m[1] / 255, g = m[2] / 255, b = m[3] / 255, mx = Math.max(r, g, b), mn = Math.min(r, g, b), l = (mx + mn) / 2, d = mx - mn;
    var sat = d === 0 ? 0 : d / (1 - Math.abs(2 * l - 1));
    if (l > 0.88 && d < 0.08) return "white";
    if (l < 0.12) return "black";
    if (d < 0.08) return l < 0.3 ? "dark grey" : l > 0.8 ? "light grey" : "grey";
    var h = d === 0 ? 0 : mx === r ? ((g - b) / d + 6) % 6 : mx === g ? (b - r) / d + 2 : (r - g) / d + 4; h *= 60;
    return h < 15 || h >= 345 ? "red" : h < 40 ? "orange" : h < 65 ? "yellow" : h < 165 ? "green" : h < 195 ? "teal" : h < 255 ? "blue" : h < 290 ? "purple" : "pink";
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
    if (xt.length > 80) continue;
    if (window.getComputedStyle(x).cursor !== "pointer") continue;
    if (!xt) { var xr = x.getBoundingClientRect(); if (!(xr.width >= 12 && xr.width <= 64 && xr.height >= 12 && xr.height <= 64) || !colourName(x)) continue; }
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
    var swatch = "";
    if (!name && rect.width <= 64 && rect.height <= 64) { swatch = colourName(el); if (swatch) name = swatch + " colour swatch"; }
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
      alt: swatch ? (swatch === "grey" ? "gray color" : swatch.replace("grey", "gray") + " color") : undefined,
      inViewport: rect.bottom > 0 && rect.right > 0 && rect.top < window.innerHeight && rect.left < window.innerWidth,
      x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2)
    });
  }
  return out;
}

module.exports = { SNAPSHOT_SCRIPT };
