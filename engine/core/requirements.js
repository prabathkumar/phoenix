/**
 * Requirements from anywhere: a public link, an uploaded file, pasted text, or a Jira key.
 *   loadRequirement({url | file:{name, base64} | text | jira:{client,key}}) -> {text, source:{kind, type, name|host, bytes}, notes:[]}
 * Formats: web pages (HTML), Markdown, plain text, CSV, JSON (OpenAPI becomes a list of endpoints), Word (.docx),
 *          Excel (.xlsx), PowerPoint (.pptx), PDF (needs pdftotext), Jira links (uses the Jira connection, not a public fetch).
 * Links are fetched with guards: http(s) only, no private/loopback/link-local/metadata addresses (checked when the
 * connection is made, so a DNS trick cannot slip past), redirects re-checked, size and time limits, no cookies or credentials.
 * Whatever comes back is untrusted: it is returned as data for the model, never run, and the gateway's injection check applies.
 */
const http = require("http");
const https = require("https");
const dns = require("dns");
const net = require("net");
const zlib = require("zlib");
const { spawnSync } = require("child_process");

const MAX_BYTES = 8 * 1024 * 1024, MAX_TEXT = 60000, MAX_REDIRECTS = 4, TIMEOUT_MS = 20000;

function privateAddress(ip) {
  if (net.isIPv6(ip)) {
    const l = ip.toLowerCase();
    if (l === "::1" || l === "::" || l.startsWith("fe80") || l.startsWith("fc") || l.startsWith("fd")) return true;
    const m = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(l); return m ? privateAddress(m[1]) : false;
  }
  const [a, b] = ip.split(".").map(Number);
  return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
}

/** One GET, no redirects. The address is checked in `lookup`, i.e. at connect time. */
function getOnce(url, { allowPrivate = false, lookup = dns.lookup } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    if (!/^https?:$/.test(u.protocol)) return reject(new Error("Only http and https links are supported."));
    if (u.username || u.password) return reject(new Error("Links with a username or password are not accepted."));
    // Literal IP addresses never go through `lookup`, so they are checked here.
    const literal = u.hostname.replace(/^\[|\]$/g, "");
    if (!allowPrivate && net.isIP(literal) && privateAddress(literal)) return reject(new Error("That address is private or internal, so it is not fetched."));
    const mod = u.protocol === "https:" ? https : http;
    const guardedLookup = (host, opts, cb) => lookup(host, { ...opts, all: false }, (err, addr, fam) => {
      if (err) return cb(err);
      if (!allowPrivate && privateAddress(addr)) return cb(new Error("That address is private or internal, so it is not fetched."));
      cb(null, addr, fam);
    });
    const req = mod.request(u, { method: "GET", lookup: guardedLookup, timeout: TIMEOUT_MS, headers: { "User-Agent": "TestOps-ai-automate/1 (requirements fetch)", Accept: "text/html,text/plain,application/json,application/pdf,*/*;q=0.5", "Accept-Encoding": "identity" } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) { res.resume(); return resolve({ redirect: new URL(res.headers.location, u).href }); }
      if (res.statusCode !== 200) { res.resume(); return reject(new Error(`The link answered ${res.statusCode}. It may need a sign-in, which public links do not.`)); }
      const chunks = []; let n = 0;
      res.on("data", (c) => { n += c.length; if (n > MAX_BYTES) { req.destroy(new Error("The file is larger than 8MB.")); } else chunks.push(c); });
      res.on("end", () => resolve({ body: Buffer.concat(chunks), type: String(res.headers["content-type"] || "").split(";")[0].trim().toLowerCase() }));
    });
    req.on("timeout", () => req.destroy(new Error("The link took too long to answer.")));
    req.on("error", reject);
    req.end();
  });
}
async function fetchPublic(url, opts = {}) {
  let cur = url;
  for (let i = 0; i <= MAX_REDIRECTS; i++) { const r = await getOnce(cur, opts); if (!r.redirect) return { ...r, url: cur }; cur = r.redirect; }
  throw new Error("Too many redirects.");
}

// ---- zip (docx, xlsx, pptx): stored and deflate entries
function unzip(buf) {
  const files = {}; let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw new Error("Not a valid Office file.");
  let p = buf.readUInt32LE(eocd + 16); const n = buf.readUInt16LE(eocd + 10);
  for (let k = 0; k < n; k++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) break;
    const method = buf.readUInt16LE(p + 10), csize = buf.readUInt32LE(p + 20), nlen = buf.readUInt16LE(p + 28), elen = buf.readUInt16LE(p + 30), clen = buf.readUInt16LE(p + 32), off = buf.readUInt32LE(p + 42);
    const name = buf.toString("utf8", p + 46, p + 46 + nlen);
    const lh = off + 30 + buf.readUInt16LE(off + 26) + buf.readUInt16LE(off + 28);
    const raw = buf.subarray(lh, lh + csize);
    if (/\.(xml|rels)$/.test(name)) files[name] = method === 0 ? raw.toString("utf8") : method === 8 ? zlib.inflateRawSync(raw, { maxOutputLength: 20 * 1024 * 1024 }).toString("utf8") : "";
    p += 46 + nlen + elen + clen;
  }
  return files;
}
const xmlText = (s) => String(s || "").replace(/<\/w:p>|<\/a:p>|<\/row>|<\/si>/g, "\n").replace(/<\/w:tc>|<\/c>/g, "\t").replace(/<w:tab\/>/g, "\t").replace(/<[^>]+>/g, "").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&");

function docxText(buf) { const f = unzip(buf); return xmlText(f["word/document.xml"]); }
function pptxText(buf) { const f = unzip(buf); return Object.keys(f).filter((k) => /^ppt\/slides\/slide\d+\.xml$/.test(k)).sort((a, b) => parseInt(a.match(/\d+/)) - parseInt(b.match(/\d+/))).map((k, i) => `Slide ${i + 1}:\n${xmlText(f[k])}`).join("\n"); }
function xlsxText(buf) {
  const f = unzip(buf);
  const shared = [...String(f["xl/sharedStrings.xml"] || "").matchAll(/<si>([\s\S]*?)<\/si>/g)].map((m) => xmlText(m[1]).trim());
  return Object.keys(f).filter((k) => /^xl\/worksheets\/sheet\d+\.xml$/.test(k)).sort().map((k, i) => {
    const rows = [...f[k].matchAll(/<row[^>]*>([\s\S]*?)<\/row>/g)].map((r) => [...r[1].matchAll(/<c(\s[^>]*?)?(?:\/>|>([\s\S]*?)<\/c>)/g)].map((c) => {
      const v = /<v>([\s\S]*?)<\/v>/.exec(c[2] || ""), inline = /<is>([\s\S]*?)<\/is>/.exec(c[2] || "");
      return /t="s"/.test(c[1] || "") && v ? shared[Number(v[1])] || "" : inline ? xmlText(inline[1]) : v ? v[1] : "";
    }).join(" | "));
    return `Sheet ${i + 1}:\n${rows.join("\n")}`;
  }).join("\n\n");
}

// ---- HTML -> readable text; OpenAPI -> endpoint list
function htmlText(html) {
  let s = String(html).replace(/<(script|style|noscript|svg|iframe|template)[\s\S]*?<\/\1>/gi, " ").replace(/<!--[\s\S]*?-->/g, " ");
  const title = (/<title[^>]*>([\s\S]*?)<\/title>/i.exec(s) || [])[1];
  s = s.replace(/<h([1-6])[^>]*>/gi, (_m, n) => "\n" + "#".repeat(Number(n)) + " ").replace(/<li[^>]*>/gi, "\n- ").replace(/<\/(p|div|tr|h[1-6]|section|article|table|ul|ol|br)>|<br\s*\/?>/gi, "\n").replace(/<\/t[dh]>/gi, " | ").replace(/<[^>]+>/g, "");
  s = s.replace(/&nbsp;/g, " ").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&amp;/g, "&").replace(/[ \t]+/g, " ").replace(/\n\s*\n+/g, "\n\n");
  return (title ? `${title.trim()}\n\n` : "") + s.trim();
}
function jsonText(text) {
  let j; try { j = JSON.parse(text); } catch { return text; }
  if (j && j.paths && (j.openapi || j.swagger)) {
    const lines = [`API: ${(j.info && j.info.title) || ""} ${(j.info && j.info.version) || ""}`.trim()];
    for (const [p, ops] of Object.entries(j.paths)) for (const [m, op] of Object.entries(ops)) if (/^(get|post|put|patch|delete)$/.test(m)) lines.push(`${m.toUpperCase()} ${p}: ${(op && (op.summary || op.description) || "").toString().slice(0, 200)}`);
    return lines.join("\n");
  }
  return JSON.stringify(j, null, 2);
}
function pdfText(buf, exec = spawnSync) {
  const r = exec("pdftotext", ["-layout", "-", "-"], { input: buf, encoding: "utf8", timeout: 60000, maxBuffer: 20 * 1024 * 1024 });
  if (r.error || r.status !== 0) throw new Error("Reading PDFs needs pdftotext on this server (poppler-utils).");
  return r.stdout;
}

function detect(name, type, buf) {
  const ext = (String(name).split("?")[0].match(/\.([A-Za-z0-9]+)$/) || [])[1];
  const e = ext ? ext.toLowerCase() : "";
  if (buf.length > 4 && buf.subarray(0, 4).toString() === "%PDF") return "pdf";
  if (buf.length > 3 && buf[0] === 0x50 && buf[1] === 0x4b) { if (e === "xlsx" || /spreadsheetml/.test(type)) return "xlsx"; if (e === "pptx" || /presentationml/.test(type)) return "pptx"; return "docx"; }
  if (e === "csv" || type === "text/csv") return "csv";
  if (e === "json" || /json/.test(type)) return "json";
  if (e === "md" || e === "markdown" || type === "text/markdown") return "md";
  if (/html/.test(type) || e === "html" || e === "htm" || /^\s*<(!doctype|html)/i.test(buf.subarray(0, 200).toString())) return "html";
  return "text";
}
function toText(kind, buf, { exec } = {}) {
  switch (kind) {
    case "pdf": return pdfText(buf, exec); case "docx": return docxText(buf); case "xlsx": return xlsxText(buf); case "pptx": return pptxText(buf);
    case "html": return htmlText(buf.toString("utf8")); case "json": return jsonText(buf.toString("utf8"));
    default: return buf.toString("utf8");
  }
}
const clip = (t, notes) => { const s = String(t).replace(/\u0000/g, "").trim(); if (s.length > MAX_TEXT) { notes.push(`Only the first ${MAX_TEXT} characters were used.`); return s.slice(0, MAX_TEXT); } return s; };

/** Jira page links: /browse/KEY or ?selectedIssue=KEY */
const jiraKeyFromUrl = (u) => { try { const x = new URL(u); return (/\/browse\/([A-Z][A-Z0-9_]+-\d+)/i.exec(x.pathname) || [])[1] || x.searchParams.get("selectedIssue") || null; } catch { return null; } };

async function loadRequirement({ url, file, text, jira, allowPrivate = process.env.TESTOPS_REQUIREMENTS_ALLOW_PRIVATE === "true", exec, fetcher = fetchPublic } = {}) {
  const notes = [];
  if (text && String(text).trim()) return { text: clip(text, notes), source: { kind: "text", type: "text", bytes: Buffer.byteLength(String(text)) }, notes };
  if (file) {
    const buf = Buffer.from(String(file.base64 || ""), "base64");
    if (!buf.length) throw new Error("The file is empty.");
    if (buf.length > MAX_BYTES) throw new Error("The file is larger than 8MB.");
    const kind = detect(file.name || "", "", buf);
    return { text: clip(toText(kind, buf, { exec }), notes), source: { kind: "file", type: kind, name: String(file.name || "").slice(0, 120), bytes: buf.length }, notes };
  }
  if (url) {
    const key = jiraKeyFromUrl(url);
    if (key && jira && jira.client) {
      const { readRequirement } = require("./jira");
      const r = await readRequirement(jira.client, key); notes.push(`Read through the Jira connection (${key}), with its linked change requests.`);
      return { text: clip(r.text, notes), source: { kind: "jira", type: "jira", name: key }, notes };
    }
    if (key) notes.push("This looks like a Jira link. Jira pages need a sign-in, so connect Jira (JIRA_BASE_URL, JIRA_EMAIL, JIRA_API_TOKEN) to read it; trying as a public page.");
    const r = await fetcher(url, { allowPrivate });
    const kind = detect(r.url || url, r.type, r.body);
    if (kind === "html" && /sign in|log in|login/i.test(htmlText(r.body.toString("utf8")).slice(0, 400)) && htmlText(r.body.toString("utf8")).length < 800) notes.push("The page looks like a sign-in screen; it may not be public.");
    return { text: clip(toText(kind, r.body, { exec }), notes), source: { kind: "link", type: kind, host: new URL(r.url || url).host, bytes: r.body.length }, notes };
  }
  throw new Error("Give a link, a file, pasted text or a Jira key.");
}
module.exports = { loadRequirement, fetchPublic, privateAddress, htmlText, docxText, xlsxText, pptxText, jsonText, unzip, detect, jiraKeyFromUrl, MAX_BYTES };
