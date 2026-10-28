# Test data layer

Decides, before a run starts, where every `${NAME}` value comes from. It sits
under both the Synthetic and Semantic layers: Semantic knows what a field needs,
Synthetic replays frozen values. The output is the plain `{ NAME: value }` map
every runner already takes as `testData`, so nothing downstream changes.

Code: `engine/core/testdata.js`. HTTP: `frontend/testdata-endpoint.js`.
Tests: `engine/test/testdata.test.js`, `frontend/test/testdata-endpoint.test.js`.

## Where a value comes from

| Source | Meaning |
|---|---|
| generated | made up in the right format (email, phone, date, amount, a NEW user's password, free text) |
| provided | typed, picked from saved values, or read from an uploaded CSV/JSON |
| needs-you | must already exist in the system (login, existing customer id, OTP, API token), so it is never invented |
| negative-only | the tester chose skip: deliberately wrong values, so only bad-login style cases can run |

Names decide it: `LOGIN_*`, `EXISTING_*`, `*_PASSWORD`, `*_ID`, OTP and token names
must exist; `NEW_*`, `SIGNUP_*`, `RANDOM_*` can be generated. A hint
(`{existing:true|false}`) overrides the name. OTPs and tokens are always needs-you.

## Rules that keep it safe

- Deterministic: same seed, same values. No model, no network.
- Fictional ranges only (`202-555-01xx`, `example.com`), never real people.
- Secret values (password, token, otp ...) are masked in every response; a saved Test Data file (`toFile`) holds the seed, choices and non-secret values only.
- If any needs-you field has no value, the English run refuses to start and names the fields (400 with `needsYou`). Nothing runs half-ready.
- Off by default: without `dataMode` the existing behaviour is unchanged.

## API

`POST /api/test-data/plan` `{steps, mode?, upload?, provided?, choices?, hints?, canCreate?, seed?}`
returns `{seed, ready, needsYou, fields}`. `POST /api/english-runs` accepts `dataMode: "generate"|"upload"`,
`dataSeed`, `dataChoices`, `dataHints`, `dataUpload`, `dataCanCreate`; send back the seed from the plan so
the run uses exactly the values that were previewed.

Also in the module: `variantsFor` (good, empty, too-long, wrong-format, below/above range), `generateBody` and
`bodyMutations` for API request bodies (from a sample and/or a small JSON schema; must-exist fields stay `${NAME}`).

## Not built yet

- "Create it for me" (sign-up page or API to add a test user) is offered when `canCreate` is set, but nothing performs the creation yet.
- "Use a saved one" has no store yet; values are typed into the table.
- Excel upload (CSV and JSON work). Mobile screen-field detection for formats.
