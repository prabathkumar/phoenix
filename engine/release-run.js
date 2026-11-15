/** node engine/release-run.js <suite.json> [--changed checkout,postpaid] [--no-heal]  -- one command per release; saves results + audit trail. */
const fs = require("fs"); const path = require("path");
const { runRelease } = require("./agents/release");
const { ollamaAsk } = require("./agents/ollama-ask");
async function main(argv) {
  const file = argv[2]; if (!file) { console.error("Usage: node engine/release-run.js <suite.json> [--changed a,b] [--no-heal]"); process.exit(2); }
  const suite = JSON.parse(fs.readFileSync(file, "utf8"));
  const ci = argv.indexOf("--changed");
  const dir = path.join(process.env.PHOENIX_DATA_DIR || ".", "release-runs"); fs.mkdirSync(dir, { recursive: true });
  const auditFile = path.join(dir, `audit-${Date.now()}.jsonl`);
  const res = await runRelease(suite, { changed: ci > -1 ? argv[ci + 1].split(",") : [], heal: !argv.includes("--no-heal"), ask: ollamaAsk() || undefined, runOpts: { log: console.log }, auditSink: (e) => fs.appendFileSync(auditFile, JSON.stringify(e) + "\n") });
  const out = path.join(dir, `release-${res.at.replace(/[:.]/g, "-")}.json`); fs.writeFileSync(out, JSON.stringify(res, null, 2));
  console.log(`\nRELEASE ${res.verdict}: passed ${res.passed}/${res.total}  blocked by site ${res.blockedBySite}  not run ${res.notRunNetwork}  flaky ${res.flaky}  failed ${res.failed}`);
  for (const g of res.gaps) console.log(`  ${g.verdict.padEnd(15)} ${g.id}  ${g.why}`);
  console.log(`  results: ${out}\n  audit:   ${auditFile}`);
  process.exit(res.failed ? 1 : 0);
}
if (require.main === module) main(process.argv).catch((e) => { console.error(e); process.exit(2); });
