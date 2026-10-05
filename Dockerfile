# TestOps Mobile — containerizes the Node-side pipeline only:
# run-session.js (engine/session.js spawn-path client + live-view + capture +
# generation), run-batch-executions.js (test-case/batch mode, including the
# BrowserStack provider path), and frontend/server.js.
#
# What this deliberately does NOT contain, and why:
#   - An Android emulator or device. Emulators need KVM/hardware acceleration
#     and a GPU-capable host; a real device needs USB passthrough. Neither
#     belongs in this image. Point this container at an Appium server
#     running on a host (or device farm) that has real hardware access, via
#     TESTOPS_MOBILE_APPIUM_HOST / TESTOPS_MOBILE_APPIUM_PORT (see .env.example).
#   - The `appium` server process itself. It has its own driver-install step
#     (`appium driver install uiautomator2`) tied to whichever machine can
#     see the device, and infra teams typically already have a place to run
#     it (a device-farm host, an existing Appium container image). Run it
#     there and point TESTOPS_MOBILE_APPIUM_HOST/PORT at it.
#   - The embedded path (engine/embedded-session.js). It talks to the
#     UiAutomator2 driver in-process, which still needs ADB access to a real
#     device/emulator on the same host — so it belongs on that host, not in
#     this general-purpose container. Run it directly there with
#     `npm run embedded-stage0` per the README, not through this image.
#
# What you get from this image: the live-view WebSocket server, session
# recorder, script generator, and the tester-facing frontend, all built and
# ready to run against whatever Appium server you point them at.

# Pinned to an exact upstream version tag AND content digest, not the
# floating "22-slim" tag -- "latest"/"22-slim" can silently change under us
# (a new Debian point release, a new Node 22.x patch) between two builds of
# the exact same commit, which is the opposite of reproducible. Bump both
# the tag and digest together on purpose, not by accident
# (`docker pull node:<tag> && docker inspect --format '{{index .RepoDigests 0}}' node:<tag>`
# to get the new digest).
#
# Bumped from 20.18.1 to 22.23.3 on 2026-10-04 -- real bug, found on a real
# BrowserStack run (addons-run-ios-docker-16.log): engine/locator-store.js's
# optional confidence/analytics layer requires `node:sqlite`, which doesn't
# exist at all before Node 22.5 -- it failed with "No such built-in module:
# node:sqlite" inside the Node 20 image and silently fell back to running
# without the store (fail-soft by design, so the actual test run wasn't
# affected -- only the new locator-store feature was silently inert).
#
# Tag and digest confirmed real via a real `docker pull node:22.23.3-slim`
# on the user's own machine -- this sandbox's own network allowlist blocks
# the Docker Hub registry entirely (confirmed by the identical 403 on the
# already-proven node:20.18.1-slim tag, and even on a trivial public
# `alpine:latest` pull), so no tag could ever have been verified from
# inside this sandbox regardless of which one was chosen; the real
# verification had to happen where Docker actually runs.
FROM node:22.23.3-slim@sha256:43ac6c60b8f89723f746e8a92ce91abd5017e627ce1ddfe4238355d3a30b772c

# Build-time version, threaded through to the OCI label below so a running
# container can report exactly what it is (`docker inspect` or
# `LABEL org.opencontainers.image.version`) -- see docs/RELEASING.md for
# where this value comes from (a `vX.Y.Z` git tag) and how it reaches here
# (docker-publish.yml's `--build-arg VERSION=...`). Defaults to "dev" for a
# plain local `docker build` with no --build-arg, so that path still works
# exactly as before.
ARG VERSION=dev

# "TestOps Mobile" (2026-10-04 rename): every package, module, env var,
# and code identifier in this repo was renamed from "Phoenix" to
# "TestOps Mobile" -- see git history for the full rename commit. The
# one thing that deliberately did NOT change is the GitHub repo's own
# name/URL below: it stays github.com/prabathkumar/phoenix permanently,
# by explicit choice -- not a "rename pending" placeholder. Don't "fix"
# this source label to point at a testops-mobile repo URL; that repo
# doesn't exist and isn't going to. See docs/TESTOPS_MOBILE_DOCKER.md for
# the full handoff workflow (build, save/load without a registry, and
# the separate GitHub-pull path for the source code itself), and
# docs/RELEASING.md for the version-tag/registry-push process.
LABEL org.opencontainers.image.title="TestOps Mobile" \
      org.opencontainers.image.description="TestOps Mobile semantic mobile-automation pipeline, packaged for TestOps integration" \
      org.opencontainers.image.vendor="YTL / Robotico" \
      org.opencontainers.image.version="${VERSION}" \
      org.opencontainers.image.source="https://github.com/prabathkumar/phoenix"

WORKDIR /app

# Install each subproject's own dependencies (they're independent
# package.json files, not a single workspace) before copying source, so
# `npm install` layers cache independently of code changes.
COPY engine/package.json engine/package-lock.json ./engine/
COPY capture/package.json capture/package-lock.json ./capture/
COPY generation/package.json generation/package-lock.json ./generation/
COPY live-view/package.json live-view/package-lock.json ./live-view/
COPY frontend/package.json frontend/package-lock.json ./frontend/

RUN npm install --prefix engine --omit=dev \
 && npm install --prefix capture --omit=dev \
 && npm install --prefix generation --omit=dev \
 && npm install --prefix live-view --omit=dev \
 && npm install --prefix frontend --omit=dev

# Now bring in the actual source.
COPY engine/ ./engine/
COPY capture/ ./capture/
COPY generation/ ./generation/
COPY live-view/ ./live-view/
COPY frontend/ ./frontend/
COPY run-session.js ./run-session.js
COPY run-batch-executions.js ./run-batch-executions.js
COPY test-cases/ ./test-cases/

# live-view + frontend ports (see .env.example for what each does).
EXPOSE 8090 8091

# TESTOPS_MOBILE_STAGE0_APP_PATH must point at a .apk reachable from wherever the
# Appium server this container talks to actually runs — not from inside
# this container — since the server/device installs and launches it, not us.
# Not applicable when TESTOPS_MOBILE_APPIUM_PROVIDER=browserstack, which uses
# TESTOPS_MOBILE_BROWSERSTACK_APP_URL instead (see .env.example).
#
# Runs run-session.js (the live-view/session/recorder/generation pipeline)
# by default. To run batch/test-case mode instead (the mode that drives
# test-cases/*.json against BrowserStack or a local Appium server), override
# the command:
#   docker run ... testops-mobile:latest node run-batch-executions.js
# To serve the local frontend instead of using the public GitHub Pages
# deploy, override the command:
#   docker run ... testops-mobile:latest node frontend/server.js
CMD ["node", "run-session.js"]
