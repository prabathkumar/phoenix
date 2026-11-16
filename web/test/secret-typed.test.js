const test = require("node:test");
const assert = require("node:assert");
const { toTestCase, toPlaywrightScript } = require("../recorder/web-codegen");

test("a value the tester marks secret is never written into the test case, its data or the script", () => {
  const steps = [
    { kind: "navigate", url: "https://x.test/", instruction: "Open" },
    { kind: "type", instruction: "Type into Password", selector: { css: "#p" }, text: "Sup3rSecret!", param: "password", secret: true },
    { kind: "type", instruction: "Type into Name", selector: { css: "#n" }, text: "Ann", param: "name" },
  ];
  const tc = JSON.stringify(toTestCase(steps, { name: "t" }));
  const sc = toPlaywrightScript(steps, { name: "t" });
  assert.ok(!tc.includes("Sup3rSecret") && !sc.includes("Sup3rSecret"));
  assert.ok(tc.includes("Ann"), "an ordinary value is kept");
  assert.match(sc, /process\.env\.password/, "the script reads the secret from the environment at run time");
});
