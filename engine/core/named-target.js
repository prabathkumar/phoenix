/**
 * Understanding what an English instruction NAMES, so the model cannot quietly swap in a different element.
 * Reported bug: "click the logo 10 times" clicked the Login button. Two causes, both handled here and in the callers:
 *   1. the count was not understood (so the loop thought "no change" and moved on to another element);
 *   2. nothing stopped the model choosing a clickable thing that is not what was named.
 */
const NUMBER_WORDS = { once: 1, twice: 2, thrice: 3, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10 };
const MAX_REPEAT = 50;

/** "click the logo 10 times" -> {text:"click the logo", times:10}. No count -> times 1. */
function parseRepeat(text) {
  const src = String(text || "").trim();
  const m = src.match(/\s*,?\s*\b(\d{1,3}|two|three|four|five|six|seven|eight|nine|ten)\s*(?:times|x)\b/i) || src.match(/\s*,?\s*\b(once|twice|thrice)\b/i);
  if (!m) return { text: src, times: 1 };
  const word = m[1].toLowerCase();
  const n = /^\d+$/.test(word) ? Number(word) : NUMBER_WORDS[word];
  const rest = (src.slice(0, m.index) + src.slice(m.index + m[0].length)).replace(/\s{2,}/g, " ").trim();
  return { text: rest, times: Math.max(1, Math.min(MAX_REPEAT, n || 1)) };
}

/** Things people name that models confuse with a nearby button. */
const NAMED = [
  { key: "logo", asked: /\b(logo|brand mark|company icon|site icon)\b/i, is: /\b(logo|brand|home)\b/i, notThese: /\b(log\s?in|sign\s?in|sign\s?up|register|submit|search|cart|menu|subscribe)\b/i },
];

/** Evidence text for an element: everything that could say what it is. */
const evidence = (el) => [el.name, el.id, el.testid, el.placeholder, el.hint, el.alt].filter(Boolean).join(" ");

/** The words a plain click instruction names: "Click Explore Devices" -> ["explore","devices"]; "Click Buy now on the vivo X500" -> ["buy","now"]. null when it is not a plain click. */
function namedWords(instruction) {
  const t = String(instruction || "").trim().replace(/[.!]+$/, "");
  let m = t.match(/^(?:click|tap|press)\s+(?:on\s+)?(?:the\s+)?(.+?)\s+(?:on|against|for|of|in|under|next to|beside)\s+(?:the\s+)?.+$/i)
    || t.match(/^(?:click|tap|press)\s+(?:on\s+)?(?:the\s+)?(.+)$/i);
  if (!m || /\b(and|then)\b|[,;]/i.test(m[1])) return null;
  const words = m[1].toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length >= 3 && !STOP.has(w) && !["menu", "tab", "option", "item", "icon"].includes(w));
  return words.length ? words : null;
}

/** If the instruction names a known thing and the element is clearly a different thing, say why. */
function mismatch(instruction, el) {
  const words = namedWords(instruction);
  if (words && !/\b(logo|brand mark|company icon|site icon)\b/i.test(String(instruction))) {
    const ev = squash([el.name, el.id, el.testid, el.placeholder, el.alt, el.hint].filter(Boolean).join(" "));
    if (!words.some((w) => ev.includes(w))) return `the instruction names "${words.join(" ")}", but "${el.name || el.role}" does not match it`;
  }
  for (const n of NAMED) {
    if (!n.asked.test(String(instruction))) continue;
    const ev = evidence(el);
    if (n.is.test(ev) || el.hint === n.key) continue;
    if (n.notThese.test(ev)) return `the instruction names the ${n.key}, but "${el.name || el.role}" is not a ${n.key}`;
  }
  return null;
}

const squash = (x) => String(x || "").toLowerCase().replace(/[^a-z0-9]+/g, "");
const STOP = new Set(["the", "a", "an", "button", "link", "icon", "on", "against", "for", "of", "in", "under", "next", "to"]);

/**
 * Reading the page, no model: "click Buy now on the vivo X500" = the control called "Buy now" that sits in the card
 * whose text names "vivo X500". Exactly one match -> that element; none or several -> says why and the model/person decides.
 */
/** "Click Explore Devices": the one control whose label is that name (an exact label wins over one that merely contains it). */
function plainName(instruction, elements) {
  const words = namedWords(instruction);
  if (!words) return null;
  const want = squash(words.join(""));
  const live = elements.filter((e) => !e.disabled && e.name);
  const exact = live.filter((e) => squash(e.name) === want);
  if (exact.length === 1) return { element: exact[0], why: `the control labelled "${exact[0].name}"` };
  if (exact.length > 1) return null; // several with that exact label: the model or a person decides
  const part = live.filter((e) => squash(e.name).includes(want));
  if (part.length === 1) return { element: part[0], why: `the only control whose label contains "${words.join(" ")}"` };
  return null;
}

function domMatch(instruction, elements) {
  const m = String(instruction || "").trim().match(/^(?:click|tap|press)\s+(?:on\s+)?(?:the\s+)?(.+?)\s+(?:on|against|for|of|in|under|next to|beside)\s+(?:the\s+)?(.+)$/i);
  if (!m) return null;
  const control = squash(m[1]), target = squash(m[2].replace(/[.!]+$/, ""));
  if (!control || !target) return null;
  const hits = elements.filter((e) => !e.disabled && squash(e.name).includes(control) && squash(e.within).includes(target));
  if (hits.length === 1) return { element: hits[0], why: `the "${m[1]}" control inside the card that names "${m[2].replace(/[.!]+$/, "")}"` };
  if (!hits.length) return { element: null, why: `no "${m[1]}" control sits next to text naming "${m[2].replace(/[.!]+$/, "")}"` };
  return { element: null, why: `${hits.length} "${m[1]}" controls sit next to text naming "${m[2]}"; cannot tell which` };
}

/** Rules every prompt carries, so the model matches the NAMED thing and declines rather than substitutes. */
const MATCH_RULES = [
  "Matching rules:",
  "- Match the thing the instruction NAMES. Never choose a different element because it is clickable, nearby, or the only button. A Login, Sign in, Submit or Search button is never \"the logo\".",
  "- A logo is the brand image or brand link, usually at the top-left of the header; it may be named after the company, \"logo\" or \"home\". Elements marked logo are the candidates.",
  "- If no element in the list is the named thing, say so (decline or fail with the reason \"no element called <name>\"). Do not pick a substitute.",
  "- A click that changes nothing visible (a logo that reloads the same page) is still a correct click. Do not switch to another element because nothing changed.",
  "- Several elements can have the same name (every product card has \"Buy now\"). Choose the one whose in: text (the card, row or section it sits in) names the thing asked for, e.g. \"Buy now on the vivo X500\" is the Buy now whose in: text contains X500.",
  "- Counts such as \"10 times\" are handled by the test runner, not by you: resolve the element once.",
].join("\n");

module.exports = { parseRepeat, mismatch, domMatch, plainName, MATCH_RULES, MAX_REPEAT };
