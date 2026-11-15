/**
 * Passive checks run by the Performance and Security agents. Passive = they only load the suite's start page like a visitor
 * (one page load, one GET); they never probe, fuzz or log in.
 */
const path = require("path");

/** Page timing for one load of `url`. Budgets are warnings, not failures. */
async function pageTiming(url, { launch, budgetMs = 5000 } = {}) {
  const launchBrowser = launch || (async () => {
    let chromium; try { ({ chromium } = require(require.resolve("playwright", { paths: [path.join(__dirname, "..", "..", "web")] }))); } catch { ({ chromium } = require("playwright")); }
    return (await require("../../web/browser-provider").launchWebBrowser({ runOn: "local", chromium })).browser;
  });
  const browser = await launchBrowser();
  try {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const page = await ctx.newPage();
    const t0 = Date.now();
    await page.goto(url, { waitUntil: "load", timeout: 45000 });
    const wallMs = Date.now() - t0;
    const nav = await page.evaluate(() => { const n = performance.getEntriesByType("navigation")[0]; const fcp = performance.getEntriesByName("first-contentful-paint")[0]; return n ? { ttfbMs: Math.round(n.responseStart), domContentLoadedMs: Math.round(n.domContentLoadedEventEnd), loadMs: Math.round(n.loadEventEnd), firstContentfulPaintMs: fcp ? Math.round(fcp.startTime) : null, transferKb: Math.round((n.transferSize || 0) / 1024) } : null; }).catch(() => null);
    await ctx.close();
    const m = { wallMs, ...(nav || {}) };
    const warnings = [];
    if ((m.loadMs || wallMs) > budgetMs) warnings.push(`page load took ${(m.loadMs || wallMs)} ms (budget ${budgetMs} ms)`);
    if (m.ttfbMs > 1500) warnings.push(`server took ${m.ttfbMs} ms to start answering (over 1500 ms)`);
    return { metrics: m, warnings };
  } finally { try { await browser.close(); } catch { /* ignore */ } }
}

/** Response-header hygiene of the start page. Reports what is missing; says nothing about exploitability. */
async function headerAudit(url, { fetchImpl = fetch } = {}) {
  const r = await fetchImpl(url, { redirect: "follow", signal: AbortSignal.timeout(30000) });
  const h = (n) => r.headers.get(n);
  const csp = h("content-security-policy") || "";
  const warnings = [];
  if (!/^https:/i.test(r.url || url)) warnings.push("the page is not served over HTTPS");
  if (!h("strict-transport-security")) warnings.push("no Strict-Transport-Security header");
  if (!csp) warnings.push("no Content-Security-Policy header");
  if (!h("x-content-type-options")) warnings.push("no X-Content-Type-Options header");
  if (!h("x-frame-options") && !/frame-ancestors/i.test(csp)) warnings.push("nothing stops other sites framing the page (no X-Frame-Options or frame-ancestors)");
  if (!h("referrer-policy")) warnings.push("no Referrer-Policy header");
  const cookies = typeof r.headers.getSetCookie === "function" ? r.headers.getSetCookie() : [];
  for (const c of cookies) { const name = c.split("=")[0]; if (!/;\s*secure/i.test(c)) warnings.push(`cookie ${name} is missing Secure`); if (!/;\s*httponly/i.test(c) && /sess|token|auth|sid/i.test(name)) warnings.push(`cookie ${name} is missing HttpOnly`); }
  return { status: r.status, finalUrl: r.url, cookies: cookies.length, warnings };
}
module.exports = { pageTiming, headerAudit };
