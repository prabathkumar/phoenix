/** Which addresses a laptop runner may open. Default deny: an empty list allows nothing.
 *  Patterns: an exact host (intranet.corp.example.com), a subdomain wildcard (*.corp.example.com, matches sub.corp.example.com but not corp.example.com),
 *  or an IPv4 range (10.20.0.0/16). Same rules as backend/phoenix_api/runner_hub.py. */
const isV4 = (s) => /^(\d{1,3})(\.\d{1,3}){3}$/.test(s) && s.split(".").every((o) => Number(o) <= 255);
const isV6 = (s) => s.includes(":");
const net = { isIPv4: isV4, isIPv6: isV6 };

const toInt = (ip) => ip.split(".").reduce((a, o) => (a * 256) + Number(o), 0);
const ALWAYS_DENY = [["169.254.0.0", 16], ["0.0.0.0", 8]];   // cloud metadata / link-local, unspecified

function inCidr(ip, base, bits) { const m = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0; return ((toInt(ip) & m) >>> 0) === ((toInt(base) & m) >>> 0); }

/** -> error text, or null when the pattern is acceptable to register. */
function badPattern(p) {
  p = String(p || "").trim().toLowerCase();
  if (!p || p.length > 120) return "empty or too long";
  if (p.includes("/")) {
    const [ip, bits] = p.split("/");
    if (net.isIPv4(ip) && /^\d{1,2}$/.test(bits) && Number(bits) >= 8 && Number(bits) <= 32) return null;
    return "a range must be IPv4 with /8 to /32";
  }
  if (p.startsWith("*.")) { const rest = p.slice(2); return /^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(rest) && rest.includes(".") ? null : "wildcard needs a domain such as *.corp.example.com"; }
  if (net.isIPv4(p) || /^[a-z0-9-]+(\.[a-z0-9-]+)*$/.test(p)) return null;
  return "not a host name or address";
}

function allowed(url, patterns) {
  let u; try { u = new URL(url); } catch { return false; }
  if (!["http:", "https:"].includes(u.protocol) || u.username || u.password) return false;
  const host = u.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (net.isIPv4(host) && ALWAYS_DENY.some(([b, n]) => inCidr(host, b, n))) return false;
  if (net.isIPv6(host) && /^(fe80|fd00:ec2)/i.test(host)) return false;
  return (patterns || []).some((raw) => {
    const p = String(raw).trim().toLowerCase();
    if (badPattern(p)) return false;
    if (p.includes("/")) { const [ip, bits] = p.split("/"); return net.isIPv4(host) && inCidr(host, ip, Number(bits)); }
    if (p.startsWith("*.")) return host.endsWith(p.slice(1)) && host.length > p.length - 1;
    return host === p;
  });
}

/** Every address a test case would open by itself: the base URL and any step that navigates. */
function urlsInSteps(steps, baseUrl) {
  const out = new Set(); if (baseUrl) out.add(baseUrl);
  for (const s of steps || []) { const m = String((s && (s.url || s.value || s.instruction)) || "").match(/https?:\/\/[^\s"')]+/g); (m || []).forEach((x) => out.add(x)); }
  return [...out];
}

export { allowed, badPattern, urlsInSteps };
