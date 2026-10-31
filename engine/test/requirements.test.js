const assert = require("assert");
const http = require("http"), zlib = require("zlib"), { spawnSync } = require("child_process");
const R = require("../core/requirements");

// tiny zip writer (deflate) for Office fixtures
const crc = (b) => { let c, t = []; for (let n = 0; n < 256; n++) { c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } let x = 0xffffffff; for (const v of b) x = t[(x ^ v) & 255] ^ (x >>> 8); return (x ^ 0xffffffff) >>> 0; };
function zip(files) {
  const parts = [], cd = []; let off = 0;
  for (const [name, text] of Object.entries(files)) {
    const data = Buffer.from(text), comp = zlib.deflateRawSync(data), nm = Buffer.from(name);
    const lh = Buffer.alloc(30); lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(8, 8); lh.writeUInt32LE(crc(data), 14); lh.writeUInt32LE(comp.length, 18); lh.writeUInt32LE(data.length, 22); lh.writeUInt16LE(nm.length, 26);
    parts.push(lh, nm, comp);
    const ch = Buffer.alloc(46); ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(8, 10); ch.writeUInt32LE(crc(data), 16); ch.writeUInt32LE(comp.length, 20); ch.writeUInt32LE(data.length, 24); ch.writeUInt16LE(nm.length, 28); ch.writeUInt32LE(off, 42);
    cd.push(ch, nm); off += lh.length + nm.length + comp.length;
  }
  const cdb = Buffer.concat(cd), end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(cd.length / 2, 8); end.writeUInt16LE(cd.length / 2, 10); end.writeUInt32LE(cdb.length, 12); end.writeUInt32LE(off, 16);
  return Buffer.concat([...parts, cdb, end]);
}
const docx = zip({ "word/document.xml": '<w:document><w:body><w:p><w:r><w:t>Users must sign in with email &amp; password.</w:t></w:r></w:p><w:p><w:r><w:t>Lock after 5 failures.</w:t></w:r></w:p></w:body></w:document>' });
const xlsx = zip({ "xl/sharedStrings.xml": "<sst><si><t>Rule</t></si><si><t>Max tries</t></si></sst>", "xl/worksheets/sheet1.xml": '<worksheet><sheetData><row><c t="s"><v>0</v></c><c t="s"><v>1</v></c></row><row><c t="inlineStr"><is><t>lockout</t></is></c><c><v>5</v></c></row></sheetData></worksheet>' });
const pptx = zip({ "ppt/slides/slide1.xml": "<p:sld><a:p><a:r><a:t>Login flow</a:t></a:r></a:p></p:sld>", "ppt/slides/slide2.xml": "<p:sld><a:p><a:r><a:t>Lockout rules</a:t></a:r></a:p></p:sld>" });
const pdfBuf = Buffer.from("%PDF-1.1\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 300 100]/Contents 4 0 R/Resources<</Font<</F1 5 0 R>>>>>>endobj\n4 0 obj<</Length 56>>stream\nBT /F1 14 Tf 10 50 Td (Password must be 12 characters) Tj ET\nendstream endobj\n5 0 obj<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>endobj\ntrailer<</Root 1 0 R/Size 6>>\n%%EOF");

(async () => {
  // office formats
  assert.ok(R.docxText(docx).includes("Users must sign in with email & password.") && R.docxText(docx).includes("Lock after 5 failures."));
  assert.ok(/Rule \| Max tries\nlockout \| 5/.test(R.xlsxText(xlsx)), R.xlsxText(xlsx));
  assert.ok(/Slide 1:\nLogin flow/.test(R.pptxText(pptx)) && /Slide 2:/.test(R.pptxText(pptx)));
  // html, openapi, detect
  assert.ok(/^# Login/m.test(R.htmlText("<html><title>T</title><script>evil()</script><h1>Login</h1><ul><li>email</li></ul></html>")) && !/evil/.test(R.htmlText("<script>evil()</script>x")));
  assert.ok(R.jsonText(JSON.stringify({ openapi: "3.0.0", info: { title: "Shop" }, paths: { "/cart": { post: { summary: "Add item" } } } })).includes("POST /cart: Add item"));
  assert.strictEqual(R.detect("a.docx", "", docx), "docx"); assert.strictEqual(R.detect("a.xlsx", "", xlsx), "xlsx"); assert.strictEqual(R.detect("x", "", pdfBuf), "pdf"); assert.strictEqual(R.detect("r.csv", "", Buffer.from("a,b")), "csv");
  assert.strictEqual(R.jiraKeyFromUrl("https://x.atlassian.net/browse/TOP-188"), "TOP-188");

  // files and text through loadRequirement
  const f = await R.loadRequirement({ file: { name: "spec.docx", base64: docx.toString("base64") } });
  assert.strictEqual(f.source.type, "docx"); assert.ok(f.text.includes("Lock after 5"));
  if (spawnSync("pdftotext", ["-v"]).status !== null) { const pf = await R.loadRequirement({ file: { name: "r.pdf", base64: pdfBuf.toString("base64") } }); assert.ok(/Password must be 12/.test(pf.text), pf.text); }
  assert.strictEqual((await R.loadRequirement({ text: "plain" })).source.kind, "text");
  await assert.rejects(R.loadRequirement({}), /Give a link/);
  await assert.rejects(R.loadRequirement({ file: { name: "x", base64: "" } }), /empty/);
  const big = await R.loadRequirement({ text: "x".repeat(70000) }); assert.strictEqual(big.text.length, 60000); assert.ok(/first 60000/.test(big.notes[0]));

  // SSRF guards
  for (const ip of ["127.0.0.1", "10.1.2.3", "192.168.0.5", "172.20.1.1", "169.254.169.254", "100.64.0.1", "::1", "fe80::1", "fd00::1", "::ffff:10.0.0.1", "0.0.0.0"]) assert.ok(R.privateAddress(ip), ip);
  for (const ip of ["8.8.8.8", "93.184.216.34", "2606:4700::1111"]) assert.ok(!R.privateAddress(ip), ip);
  let hits = 0;
  const site = http.createServer((req, res) => {
    hits++;
    if (req.url === "/page") { res.writeHead(200, { "Content-Type": "text/html" }); return res.end("<html><title>Spec</title><h1>Login</h1><p>Users sign in.</p></html>"); }
    if (req.url === "/doc") { res.writeHead(200, { "Content-Type": "application/vnd.openxmlformats-officedocument.wordprocessingml.document" }); return res.end(docx); }
    if (req.url === "/go-internal") { res.writeHead(302, { Location: "http://169.254.169.254/latest/meta-data/" }); return res.end(); }
    if (req.url === "/loop") { res.writeHead(302, { Location: "/loop" }); return res.end(); }
    if (req.url === "/private") { res.writeHead(401); return res.end(); }
    res.writeHead(200, { "Content-Type": "text/plain" }); res.end("x");
  });
  await new Promise((ok) => site.listen(0, "127.0.0.1", ok));
  const base = `http://127.0.0.1:${site.address().port}`;
  await assert.rejects(R.loadRequirement({ url: base + "/page" }), /private or internal/);          // loopback refused by default
  assert.strictEqual(hits, 0);                                                                       // no request was ever sent
  const page = await R.loadRequirement({ url: base + "/page", allowPrivate: true });
  assert.strictEqual(page.source.type, "html"); assert.ok(page.text.includes("Users sign in.")); assert.strictEqual(page.source.host, `127.0.0.1:${site.address().port}`);
  const dl = await R.loadRequirement({ url: base + "/doc", allowPrivate: true }); assert.strictEqual(dl.source.type, "docx");
  await assert.rejects(R.loadRequirement({ url: base + "/loop", allowPrivate: true }), /Too many redirects/);
  await assert.rejects(R.loadRequirement({ url: base + "/private", allowPrivate: true }), /answered 401.*sign-in/);
  // a redirect to a metadata address is refused even when the first hop is allowed to be local
  const guarded = R.fetchPublic(base + "/go-internal", { allowPrivate: false, lookup: (h, o, cb) => cb(null, h === "169.254.169.254" ? "169.254.169.254" : "93.184.216.34", 4) });
  await assert.rejects(guarded);
  for (const bad of ["http://[::1]/", "http://2130706433/", "http://0x7f.0.0.1/", "http://169.254.169.254/latest/meta-data/", "http://localhost.localdomain/"]) await assert.rejects(R.loadRequirement({ url: bad, fetcher: (u, o) => R.fetchPublic(u, { ...o, lookup: (h, op, cb) => cb(null, "127.0.0.1", 4) }) }), /private or internal|ENOTFOUND|EAI_AGAIN/, bad);
  await assert.rejects(R.loadRequirement({ url: "ftp://x/y" }), /http and https/);
  await assert.rejects(R.loadRequirement({ url: "https://user:pw@example.com/" }), /username or a password|username or password/);
  site.close();

  // Jira link goes through the Jira connection
  const jiraCalls = [];
  const jira = { client: { missing: [], config: {}, call: async (m, p) => { jiraCalls.push(p); return { key: "TOP-188", fields: { summary: "Linked IDs", description: null, status: { name: "Open" }, issuetype: { name: "Story" }, issuelinks: [] } }; } } };
  const j = await R.loadRequirement({ url: "https://x.atlassian.net/browse/TOP-188", jira });
  assert.strictEqual(j.source.kind, "jira"); assert.ok(j.text.includes("Linked IDs")); assert.ok(jiraCalls.length === 1);
  console.log("requirements tests passed");
})().catch((e) => { console.error(e); process.exit(1); });
