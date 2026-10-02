# Phoenix — containerizes the Node-side pipeline only:
# run-session.js (engine/session.js spawn-path client + live-view + capture +
# generation) and frontend/server.js.
#
# What this deliberately does NOT contain, and why:
#   - An Android emulator or device. Emulators need KVM/hardware acceleration
#     and a GPU-capable host; a real device needs USB passthrough. Neither
#     belongs in this image. Point this container at an Appium server
#     running on a host (or device farm) that has real hardware access, via
#     PHOENIX_APPIUM_HOST / PHOENIX_APPIUM_PORT (see .env.example).
#   - The `appium` server process itself. It has its own driver-install step
#     (`appium driver install uiautomator2`) tied to whichever machine can
#     see the device, and infra teams typically already have a place to run
#     it (a device-farm host, an existing Appium container image). Run it
#     there and point PHOENIX_APPIUM_HOST/PORT at it.
#   - The embedded path (engine/embedded-session.js). It talks to the
#     UiAutomator2 driver in-process, which still needs ADB access to a real
#     device/emulator on the same host — so it belongs on that host, not in
#     this general-purpose container. Run it directly there with
#     `npm run embedded-stage0` per the README, not through this image.
#
# What you get from this image: the live-view WebSocket server, session
# recorder, script generator, and the tester-facing frontend, all built and
# ready to run against whatever Appium server you point them at.

FROM node:20-slim

# Distribution label only -- this does not rename any package, module, or
# code identifier inside the repo (nothing in engine/, generation/,
# capture/, live-view/, or frontend/ changes). "TestOps Mobile" is the name
# this image is handed to the TestOps dev team under; the code underneath
# is still Phoenix. See docs/TESTOPS_MOBILE_DOCKER.md for the full handoff
# workflow (build, save/load without a registry, and the separate
# GitHub-pull path for the source code itself).
LABEL org.opencontainers.image.title="TestOps Mobile" \
      org.opencontainers.image.description="Phoenix semantic mobile-automation pipeline, packaged for TestOps integration" \
      org.opencontainers.image.vendor="YTL / Robotico"

WORKDIR /app

# Install each subproject's own dependencies (they're independent
# package.json files, not a single workspace) before copying source, so
# `npm install` layers cache independently of code changes.
COPY engine/package.json engine/package-lock.json ./engine/
COPY capture/package.json capture/package-lock.json ./capture/
COPY generation/package.json generation/package-lock.json ./generation/
COPY live-view/package.json live-view/package-lock.json ./live-view/

RUN npm install --prefix engine --omit=dev \
 && npm install --prefix capture --omit=dev \
 && npm install --prefix generation --omit=dev \
 && npm install --prefix live-view --omit=dev

# Now bring in the actual source.
COPY engine/ ./engine/
COPY capture/ ./capture/
COPY generation/ ./generation/
COPY live-view/ ./live-view/
COPY frontend/ ./frontend/
COPY run-session.js ./run-session.js

# live-view + frontend ports (see .env.example for what each does).
EXPOSE 8090 8091

# PHOENIX_STAGE0_APP_PATH must point at a .apk reachable from wherever the
# Appium server this container talks to actually runs — not from inside
# this container — since the server/device installs and launches it, not us.
#
# Runs run-session.js (the live-view/session/recorder/generation pipeline)
# by default. To serve the local frontend instead of using the public
# GitHub Pages deploy, override the command:
#   docker run ... phoenix node frontend/server.js
CMD ["node", "run-session.js"]
