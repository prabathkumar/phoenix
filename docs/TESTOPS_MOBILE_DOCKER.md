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
still Phoenix, and nothing in `engine/`, `generation/`, `capture/`,
`live-view/`, or `frontend/` changed for this. Internally, everyone working
in this repo keeps calling it Phoenix; "TestOps Mobile" is what the image
is labeled as when it leaves this repo.

## 1. What the Docker image contains (and doesn't)

Same scope as the plain Phoenix image described in the `Dockerfile`'s own
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

Or, with the repo checked out (so `docker-compose.yml` is available):

```
docker compose up --build
```

Either way, `PHOENIX_APPIUM_HOST`/`PORT` (or the BrowserStack
`PHOENIX_APPIUM_PROVIDER=browserstack` variables) must point at wherever
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

## 5. Known gaps / things not decided here

- No registry push is set up (deliberately — this sandbox has no
  credentials or visibility into TestOps's infrastructure). Once they pick
  one, swapping `scripts/build-testops-mobile.sh`'s export step for a push
  is a one-line change.
- No version-pinning/release process beyond "tag by git commit hash" is
  prescribed, since the user left deployment process unspecified
  ("[No preference]"). TestOps's own release conventions should take
  precedence once this moves into their org.
