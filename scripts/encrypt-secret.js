#!/usr/bin/env node
/**
 * Encrypts one secret for .env so the plain value is never stored in a file.
 *   TESTOPS_SECRETS_KEY=<8+ char passphrase> node scripts/encrypt-secret.js LOGIN_PASSWORD
 * It asks for the value with hidden typing, then prints a line to put in .env:
 *   PHOENIX_TEST_LOGIN_PASSWORD=enc:...
 * Phoenix decrypts it in memory only when a step uses ${LOGIN_PASSWORD}; results keep it masked.
 */
const readline = require("readline");
const { encrypt } = require("../engine/core/testdata-store");

const name = String(process.argv[2] || "").toUpperCase();
if (!/^[A-Z][A-Z0-9_]*$/.test(name)) { console.error("Usage: node scripts/encrypt-secret.js NAME   (e.g. LOGIN_PASSWORD)"); process.exit(1); }
if (!process.env.TESTOPS_SECRETS_KEY || process.env.TESTOPS_SECRETS_KEY.length < 8) { console.error("Set TESTOPS_SECRETS_KEY (8+ characters) first."); process.exit(1); }

const rl = readline.createInterface({ input: process.stdin, output: process.stderr, terminal: true });
rl._writeToOutput = (s) => { if (s.includes("Value")) process.stderr.write(s); }; // hide what is typed
rl.question(`Value for ${name} (hidden): `, (v) => {
  rl.close(); process.stderr.write("\n");
  if (!v) { console.error("Nothing entered."); process.exit(1); }
  console.log(`PHOENIX_TEST_${name}=enc:${Buffer.from(JSON.stringify(encrypt({ v }))).toString("base64")}`);
});
