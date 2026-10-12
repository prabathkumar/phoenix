/**
 * Turns recorded web steps into (a) the test-case JSON web/run-web-test-case.js
 * replays and (b) a standalone @playwright/test script.
 */

/**
 * Scroll steps are noise in a generated test: Playwright scrolls every element
 * into view before acting on it. They stay in the live steps list but are not
 * emitted.
 */
function withoutScrolls(steps) {
  const out = [];
  for (const s of steps) {
    if (s.kind === "scroll") continue;
    // Repeated clicks on the very same element (testers poking at a control)
    // collapse into one; keep the latest outcome.
    const prev = out[out.length - 1];
    if (prev && prev.kind === "tap" && s.kind === "tap" && prev.selector && s.selector &&
        JSON.stringify(prev.selector) === JSON.stringify(s.selector)) {
      out[out.length - 1] = s;
      continue;
    }
    out.push(s);
  }
  return out;
}

/** "https://www.yes.my/devices" -> "yes_my_web_flow" */
function inferWebFlowName(steps) {
  const nav = steps.find((s) => s.kind === "navigate");
  try {
    const host = new URL(nav.url).hostname.replace(/^www\./, "");
    return `${host.replace(/[^a-z0-9]+/gi, "_").toLowerCase()}_web_flow`;
  } catch {
    return "recorded_web_flow";
  }
}

/** Constant name for a typed value: the tester's test-data name when given, else field_N. */
function paramName(step, index) {
  return step.param ? String(step.param).replace(/[^A-Za-z0-9_]/g, "_") : `field_${index}`;
}

function toTestCase(rawSteps, { name, baseUrl } = {}) {
  const steps = withoutScrolls(rawSteps);
  name = name && name !== "recorded_web_flow" ? name : inferWebFlowName(steps);
  let origin = baseUrl;
  if (!origin) {
    const nav = steps.find((s) => s.kind === "navigate");
    try { origin = nav && new URL(nav.url).origin; } catch { /* ignore */ }
  }
  const testData = {};
  steps.forEach((s) => { if (s.kind === "type" && s.param) testData[paramName(s, 0)] = s.text; });
  return {
    name,
    description: "Recorded from a live browsing session by TestOps ai-automate (web recorder).",
    platform: "web",
    ...(origin ? { baseUrl: origin } : {}),
    ...(Object.keys(testData).length ? { testData } : {}),
    steps: steps.map((s) => (s.kind === "type" && s.param ? { ...s, text: "${" + paramName(s, 0) + "}" } : { ...s })),
  };
}

const q = (v) => JSON.stringify(String(v));

function locatorExpr(sel) {
  const pin = Number.isInteger(sel.nth) ? `.nth(${sel.nth})` : ".first()";
  switch (sel.strategy) {
    case "testid": return `page.getByTestId(${q(sel.value)})${Number.isInteger(sel.nth) ? pin : ""}`;
    case "label": return `page.getByLabel(${q(sel.value)})${pin}`;
    case "text": return `page.getByText(${q(sel.value)})${pin}`;
    case "role": return `page.getByRole(${q(sel.role)}, { name: ${q(sel.value)}${sel.exact === true ? ", exact: true" : ""} })${pin}`;
    case "xpath": return `page.locator(${q("xpath=" + sel.value)})`;
    default: return `page.locator(${q(sel.value)})${pin}`;
  }
}

const READ_PATH_HELPER = `function readPath(root, path) {
  let p = String(path).replace(/^\\$\\.?/, "");
  let cur = root;
  for (const m of p.matchAll(/([^.[\\]]+)|\\[(\\d+)\\]/g)) {
    const k = m[1] !== undefined ? m[1] : Number(m[2]);
    if (cur == null || typeof cur !== "object" || !(k in cur)) return undefined;
    cur = cur[k];
  }
  return cur;
}`;

/** "/orders/${ID}" -> a JS template literal; known test-data/saved names are variables, anything else is read from the environment. */
function toTemplate(text, known) {
  const body = String(text).replace(/\\/g, "\\\\").replace(/`/g, "\\`").replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_, n) => (known.has(n) ? "${" + n + "}" : "${process.env." + n + "}"));
  return "`" + body + "`";
}

function apiLines(s, known) {
  const method = String(s.method || "GET").toUpperCase();
  const out = [];
  const headers = Object.entries(s.headers || {});
  const opts = [`method: ${q(method)}`];
  if (headers.length) opts.push(`headers: { ${headers.map(([k, v]) => `${q(k)}: ${toTemplate(v, known)}`).join(", ")} }`);
  if (s.body !== undefined && method !== "GET" && method !== "HEAD") {
    opts.push(typeof s.body === "string" ? `data: ${toTemplate(s.body, known)}` : `data: ${JSON.stringify(s.body)}`);
  }
  out.push("  {");
  out.push(`    const res = await page.request.fetch(${toTemplate(s.url, known)}, { ${opts.join(", ")} });`);
  const e = s.expect || {};
  if (e.status !== undefined) {
    out.push(Array.isArray(e.status) ? `    expect(${JSON.stringify(e.status)}).toContain(res.status());` : `    expect(res.status()).toBe(${e.status});`);
  } else if (!s.expect) out.push("    expect(res.ok()).toBeTruthy();");
  const needsJson = (e.json && e.json.length) || Object.keys(s.save || {}).length;
  if (needsJson) out.push("    const body = await res.json();");
  if (e.bodyContains !== undefined) out.push(`    expect(await res.text()).toContain(${q(e.bodyContains)});`);
  for (const c of e.json || []) {
    if (c.exists === false) out.push(`    expect(readPath(body, ${q(c.path)})).toBeUndefined();`);
    else if ("equals" in c) out.push(`    expect(readPath(body, ${q(c.path)})).toEqual(${JSON.stringify(c.equals)});`);
    else if ("contains" in c) out.push(`    expect(String(readPath(body, ${q(c.path)}))).toContain(${q(c.contains)});`);
    else if ("matches" in c) out.push(`    expect(String(readPath(body, ${q(c.path)}))).toMatch(new RegExp(${q(c.matches)}));`);
    else out.push(`    expect(readPath(body, ${q(c.path)})).toBeDefined();`);
  }
  for (const [name, path] of Object.entries(s.save || {})) out.push(path === "status" ? `    ${name} = res.status();` : `    ${name} = readPath(body, ${q(path)});`);
  if (e.maxMs !== undefined) out.push(`    // expected under ${e.maxMs} ms`);
  out.push("  }");
  return out;
}

function toPlaywrightScript(rawSteps, { name } = {}) {
  const steps = withoutScrolls(rawSteps);
  name = name && name !== "recorded_web_flow" ? name : inferWebFlowName(steps);
  const lines = [];
  const params = [];
  steps.forEach((s, i) => { if (s.kind === "type") params.push([paramName(s, i), s.text, Boolean(s.param)]); });

  lines.push(`// Generated by TestOps ai-automate from a recorded browser session — ${steps.length} step(s).`);
  lines.push(`// Locators: data-testid > role+name > label > id > name/placeholder > text > css path (pinned with .nth() when not unique).
//  Scrolling is not recorded: Playwright scrolls elements into view itself.`);
  lines.push(`const { test, expect } = require("@playwright/test");`, "");
  const apiSteps = steps.filter((s) => s.kind === "api");
  const saved = apiSteps.flatMap((s) => Object.keys(s.save || {}));
  const known = new Set([...params.map((p) => p[0]), ...saved]);
  if (apiSteps.length) {
    lines.push(READ_PATH_HELPER, "");
    if (saved.length) lines.push(`// Values saved from API responses, used by later steps.`, `let ${saved.join(", ")};`, "");
  }
  if (params.length) {
    lines.push("// Test data — lifted from values typed during recording.");
    params.forEach(([n, v, named]) => lines.push(named ? `const ${n} = process.env.${n} ?? ${q(v)};` : `const ${n} = ${q(v)};`));
    lines.push("");
  }
  lines.push(`test(${q(name)}, async ({ page }) => {`);
  steps.forEach((s, i) => {
    lines.push(`  // Step ${i + 1}: ${s.instruction || s.kind}`);
    if (s.kind === "navigate") lines.push(`  await page.goto(${q(s.url)});`);
    else if (s.kind === "tap") {
      if (s.selector) lines.push(`  await ${locatorExpr(s.selector)}.click();`);
      else lines.push(`  // no stable locator was found for this click — re-record it on a labelled element`);
      for (const t of (s.expect && s.expect.appeared) || []) {
        lines.push(`  await expect(page.getByText(${q(t)}).first()).toBeVisible(); // ${JSON.stringify(t)} appeared`);
      }
    } else if (s.kind === "api") lines.push(...apiLines(s, known));
    else if (s.kind === "type") lines.push(`  await ${locatorExpr(s.selector)}.fill(${paramName(s, i)});`);
    else if (s.kind === "select") {
      lines.push(`  await ${locatorExpr(s.selector)}.selectOption({ label: ${q(s.option)} });`);
      for (const t of (s.expect && s.expect.appeared) || []) {
        lines.push(`  await expect(page.getByText(${q(t)}).first()).toBeVisible(); // ${JSON.stringify(t)} appeared`);
      }
    }
    else if (s.kind === "press") {
      lines.push(`  await ${locatorExpr(s.selector)}.press(${q(s.key)});`);
      for (const t of (s.expect && s.expect.appeared) || []) {
        lines.push(`  await expect(page.getByText(${q(t)}).first()).toBeVisible(); // ${JSON.stringify(t)} appeared`);
      }
    }
    else if (s.kind === "scroll") lines.push(`  await page.mouse.wheel(0, ${s.direction === "up" ? -600 : 600});`);
    else if (s.kind === "assert" && s.assert && s.assert.urlContains) {
      lines.push(`  await expect(page).toHaveURL(new RegExp(${q(s.assert.urlContains.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))}));`);
    }
    lines.push("");
  });
  lines.push("});", "");
  return lines.join("\n");
}

module.exports = { toTestCase, toPlaywrightScript, inferWebFlowName };
