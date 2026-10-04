# TestOps Mobile — Docker handoff

This doc covers the two separate things being handed to Hemant's TestOps
dev team, and why they're kept separate:

1. **A downloadable Docker image** ("TestOps Mobile") they can run
   immediately to see the pipeline work, with no build toolchain of their
   own required.
2. **The source code itself**, via a direct GitHub pull into their own
   company TestOps org, for the actual integration work.

"TestOps Mobile" is a distribution name only. It does not rename any
package, module, or code identifier in this repo — the code underneath is
still TestOps Mobile, and nothing in `engine/`, `generation/`, `capture/`,
`live-view/`, or `frontend/` changed for this. Internally, everyone working
in this repo keeps calling it TestOps Mobile; "TestOps Mobile" is what the image
is labeled as when it leaves this repo.

## 1. What the Docker image contains (and doesn't)

Same scope as the plain TestOps Mobile image described in the `Dockerfile`'s own
header comment: the Node-side pipeline only (`run-session.js`, the
live-view WebSocket server, session recorder, script generator, and
`frontend/server.js`). It deliberately does **not** contain:

- An Android emulator or real device (needs hardware access/USB passthrough
  the container can't have).
- The `appium` server process itself.
- The embedded session path (`engine/embedded-session.js`), which needs
  direct ADB access on the same host as the device.

So running this container gets you the automation pipeline; it still needs
to be pointed at an Appium server (local, a device farm, or BrowserStack)
exactly as described in `docs/SETUP.md` and `.env.example`.

## 2. Building and exporting the image

This sandbox has no container registry wired in, and the user left the
deployment target unspecified, so the handoff path is a plain exported
file rather than a registry push:

```
./scripts/build-testops-mobile.sh [version]
```

This builds the image as `testops-mobile:<version>` (default: the current
git commit's short hash, so every export traces back to exact source) and
writes `dist/testops-mobile-<version>.tar.gz`. That file is what gets
uploaded wherever the team shares files (internal file share, a GitHub
Release asset on the repo once it's in their org, S3 bucket, etc.) for
Hemant's team to download.

If TestOps already has their own container registry, swap the
`docker save` step in that script for `docker tag` + `docker push` to it —
the build step is identical either way. That swap is left to them, since
this sandbox has no visibility into what registry they use.

## 3. Receiving and running it (no registry)

On the machine that downloaded `testops-mobile-<version>.tar.gz`:

```
gunzip -c testops-mobile-<version>.tar.gz | docker load
cp .env.example .env   # fill in required values -- see .env.example
docker run --env-file .env -p 8090:8090 -p 8091:8091 testops-mobile:<version>
```

**Before running against real BrowserStack hardware, check `.env` for free:**

```
node check-env.js test-cases/<your-test-case>.json
```

`check-env.js` (repo root, zero dependencies, no Docker/Appium/BrowserStack
involved) parses `.env` the same way Docker's `--env-file` does, so a line
like `TESTOPS_MOBILE_BATCH_LOGIN_PASSWORD=` (present, but nothing after the `=`)
is correctly reported as `EMPTY`, never confused with `SET` or `MISSING` —
the exact failure mode a quick `grep`/glance at `.env` can't catch. Exits
non-zero on any problem, costs nothing, and never prints a credential's
real value.

Or, with the repo checked out (so `docker-compose.yml` is available):

```
docker compose up --build
```

Either way, `TESTOPS_MOBILE_APPIUM_HOST`/`PORT` (or the BrowserStack
`TESTOPS_MOBILE_APPIUM_PROVIDER=browserstack` variables) must point at wherever
an Appium server or device-farm connection already exists — this
container does not provide one.

## 4. The code itself — separate from the image

The Docker image is for trying the pipeline out quickly. For the actual
integration work, the user is sharing the GitHub repo directly with
Hemant's team, who will pull it into their own company TestOps GitHub org.
That's a normal `git clone`/mirror into their org, not something this
Docker workflow needs to handle — the two are independent:

- Want to see it run today → download and `docker load` the image above.
- Want to integrate it into TestOps's own codebase → pull the GitHub repo
  into their org and build from source there (same `Dockerfile`, same
  `docs/SETUP.md`).

See `docs/TESTOPS_INTEGRATION_GUIDE.md` for the data model/fields contract
and the frothAI (Ollama) wiring details the dev team needs for that
integration work.

### The `mcp/` connector is separate from this image, on purpose

`mcp/server.js` (see `mcp/README.md`) is a standard MCP server exposing
TestOps Mobile's locator-confidence data, test cases, and execution log to an
external MCP client — built for the user's own TestOps MCP to pull from
ahead of its Claude-marketplace integration. It is **not** built into the
`testops-mobile` image above and doesn't need to be: it's a separate,
optional Node process (`cd mcp && npm install && node server.js`), run
wherever the MCP client that wants to query it can reach it — the same
machine as this container, a different one, or directly against a cloned
checkout with no container involved at all. Keeping it a separate package
(its own `package.json`, its own dependency on `@modelcontextprotocol/sdk`)
means the main image's dependency footprint is unaffected whether or not
anyone ever runs the connector.

## 5. Known gaps / things not decided here

- **Registry push and version-pinning are now implemented** — see
  [`docs/RELEASING.md`](RELEASING.md) for the full scheme: a `vX.Y.Z` git
  tag triggers `.github/workflows/docker-publish.yml`, which builds and
  pushes to `ghcr.io/<owner>/testops-mobile` using the `GITHUB_TOKEN` Actions
  already provides, and the base image is pinned to an exact
  `node:20.18.1-slim` version rather than the floating `20-slim` tag.
  **Stated plainly: this is unverified** — no real tag has been pushed
  from this sandbox (no outbound registry access here), so the push step
  itself hasn't actually run yet. `scripts/build-testops-mobile.sh`'s
  no-registry file-handoff path above is unaffected and still works
  exactly as described for a team that can't reach `ghcr.io/<owner>/testops-mobile`.
  If TestOps prefers their own registry (ECR, Harbor, Docker Hub, GCR)
  instead, swapping it in only touches `docker-publish.yml`'s login/push
  steps — see `docs/RELEASING.md`'s own notes on that.
