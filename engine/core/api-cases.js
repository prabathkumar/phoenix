/**
 * Runs an API test case and, when asked, its generated negative cases, with no
 * device. Uses runScriptSteps (same checks, saved values and test-data layer as
 * a mobile test case that has api steps).
 */
const { runScriptSteps } = require("../test-case-runner");
const td = require("./testdata");

const noUi = async () => { throw new Error("this is an API-only run; there is no screen to act on"); };

/**
 * @param {{steps:Object[], testData?:Object, baseUrl?:string, seed?:string, negative?:boolean, fetchFn?:Function}} o
 * @returns {Promise<{seed:string, main:{success:boolean, detail:string}, negatives:{name:string, success:boolean, detail:string}[], passed:number, failed:number}>}
 */
async function runApiCases({ steps, testData = {}, baseUrl, seed = String(Date.now()), negative = false, fetchFn }) {
  const run = (list) => runScriptSteps({}, list, { platform: "android", executeSemanticAction: noUi, sleepFn: async () => {}, testData, apiBaseUrl: baseUrl, fetchFn, testDataLayer: { seed } });
  const one = (r) => ({ success: !!r.success, detail: r.success ? `${(r.steps || []).length} api step(s) passed` : String(r.detail || "") });
  const main = one(await run(steps));
  const negatives = [];
  if (negative) {
    for (const c of td.negativeApiCases(steps, { seed })) negatives.push({ name: c.name, ...one(await run(c.steps)) });
  }
  const all = [main, ...negatives];
  return { seed, main, negatives, passed: all.filter((x) => x.success).length, failed: all.filter((x) => !x.success).length };
}

module.exports = { runApiCases };
