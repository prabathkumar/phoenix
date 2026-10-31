const assert = require("assert");
const J = require("../core/jira");
const env = { JIRA_BASE_URL: "https://x.atlassian.net/", JIRA_EMAIL: "a@b.c", JIRA_API_TOKEN: "TOK3N-secret", JIRA_PROJECT_KEY: "TST" };
const calls = [];
const issues = {
  "TOP-1": { key: "TOP-1", fields: { summary: "Linked IDs are read-only", description: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "View pages must not allow edits." }] }] }, status: { name: "Open" }, issuetype: { name: "Story" }, issuelinks: [{ outwardIssue: { key: "TOP-2" } }, { inwardIssue: { key: "TOP-9" } }] } },
  "TOP-2": { key: "TOP-2", fields: { summary: "CR: show ID as text", description: null, status: { name: "Open" }, issuetype: { name: "Change" }, issuelinks: [] } },
  "TST-7": { key: "TST-7", fields: { summary: "d", status: { name: "Done" }, issuetype: { name: "Bug" }, issuelinks: [] } },
};
let dup = null;
const fetchFn = async (url, o) => {
  calls.push({ url, method: o.method, auth: o.headers.Authorization, body: o.body });
  const send = (code, obj) => ({ ok: code < 400, status: code, text: async () => JSON.stringify(obj) });
  const m = url.match(/\/issue\/([^/?]+)(\/[a-z]+)?/);
  if (o.method === "GET" && m && !m[2]) return issues[m[1]] ? send(200, issues[m[1]]) : send(404, { errorMessages: ["secret echo"] });
  if (url.includes("/search/jql")) return send(200, { issues: dup ? [dup] : [] });
  if (o.method === "POST" && url.endsWith("/rest/api/3/issue")) return send(201, { key: "TST-50" });
  if (url.endsWith("/comment")) return send(201, {});
  if (url.endsWith("/transitions") && o.method === "GET") return send(200, { transitions: [{ id: "31", name: "Done" }] });
  if (url.endsWith("/transitions")) return send(204, {});
  return send(500, {});
};

(async () => {
  const j = J.client({ env, fetchFn });
  assert.strictEqual(j.config.token, undefined);

  // In: requirement with its change request; the unreadable link is left out.
  const req = await J.readRequirement(j, "TOP-1");
  assert.ok(req.text.includes("View pages must not allow edits.") && req.text.includes("CR: show ID as text"));
  assert.deepStrictEqual(req.linked, ["TOP-2"]);
  assert.ok(calls[0].auth.startsWith("Basic ") && calls[0].url.startsWith("https://x.atlassian.net/rest"));
  // Errors never echo Jira's response body.
  await assert.rejects(J.readIssue(j, "NOPE"), (e) => /failed \(404\)/.test(e.message) && !/secret echo/.test(e.message));

  // In: fixed defects are ready to re-test.
  assert.deepStrictEqual(await J.defectsToRetest(j, ["TST-7", "TOP-1"]), [{ key: "TST-7", status: "Done" }]);

  // Out: draft hides secrets; new defect created; duplicate gets a comment instead.
  const draft = J.draftDefect({ id: "TST-TC-5096", name: "Linked IDs not editable", step: "Try to edit the ID", error: "typed hunter22 into field", ranOn: { label: "Chromium on BrowserStack" } }, { requirement: "TOP-1", secrets: ["hunter22"] });
  assert.ok(!draft.description.includes("hunter22") && draft.description.includes("Chromium on BrowserStack"));
  assert.deepStrictEqual(await J.logDefect(j, draft), { created: true, key: "TST-50" });
  dup = { key: "TST-44" };
  assert.deepStrictEqual(await J.logDefect(j, draft), { commented: true, key: "TST-44" });
  const created = calls.find((c) => c.method === "POST" && c.url.endsWith("/rest/api/3/issue"));
  assert.ok(JSON.parse(created.body).fields.labels.includes(draft.marker));
  assert.ok(!calls.map((c) => c.body || "").join("").includes("TOK3N"));

  // Move an issue; an unknown move is a plain error.
  await J.transition(j, "TST-50", "done");
  await assert.rejects(J.transition(j, "TST-50", "Nope"), /no "Nope" move/);

  // Not connected: plain words, no call.
  const off = J.client({ env: {}, fetchFn });
  await assert.rejects(J.readIssue(off, "X-1"), /JIRA_BASE_URL, JIRA_EMAIL, JIRA_API_TOKEN/);
  const h = await J.defectsHandler(off)({ failedCases: [{ name: "x" }] });
  assert.strictEqual(h.unavailable, true);
  assert.deepStrictEqual(await J.defectsHandler(off)({}), { ok: true, detail: "no failed cases" });
  console.log("jira tests passed");
})().catch((e) => { console.error(e); process.exit(1); });
