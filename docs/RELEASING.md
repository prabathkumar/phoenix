# Releasing — version scheme and registry publish

This covers the two backlog items this doc closes: a real version-tag
scheme for the "TestOps Mobile" Docker image, and an automated build+push
to a container registry. **Status, stated plainly: implemented, but
unverified until the first real tag push runs it** — this sandbox has no
outbound registry access (confirmed elsewhere in this repo, e.g.
`docs/STATUS.md`'s BrowserStack-API-blocked note), so neither the
`docker build` with the new `VERSION` build-arg nor the GitHub Actions
push step has actually been executed end to end from here. Treat the
first real `vX.Y.Z` tag push as the first real test, and check its
Actions run (`docker-publish.yml`) before trusting the resulting image.
(This sandbox also has no Docker daemon reachable, so not even a local
`docker build .` with the new `VERSION` build-arg could be run from here —
the Dockerfile/workflow changes are reviewed by inspection, not by a real
build.)

## Why git tags, not a root `package.json`

The five subprojects (`engine/`, `capture/`, `generation/`, `live-view/`,
`frontend/`) each have their own independent `package.json` with their own
version (mostly still `0.0.1` — they're not released as separate npm
packages, so those numbers have never needed to move). There's no root
`package.json` for the repo as a whole, and inventing one just to hold a
version number would be a second source of truth alongside whatever a git
tag already says — the two would drift. A git tag is already the thing
this repo's own prior Docker handoff defaulted to when no version was
given (`scripts/build-testops-mobile.sh`'s `git rev-parse --short HEAD`
fallback), so the scheme below extends that same idea into a real semver
tag instead of a commit hash.

## The scheme

1. Cut a release by tagging a commit on `main` with an annotated tag:
   `git tag -a v1.0.0 -m "v1.0.0" && git push origin v1.0.0`.
2. Pushing a tag matching `v[0-9]+.[0-9]+.[0-9]+` triggers
   `.github/workflows/docker-publish.yml`, which builds the image from
   that commit and pushes it to `ghcr.io/<owner>/phoenix` tagged:
   - the exact version (`1.0.0`)
   - the minor line (`1.0`)
   - the major line (`1`)
   - `latest`
3. The same version string is baked into the image itself via the
   Dockerfile's `ARG VERSION` / `LABEL org.opencontainers.image.version`,
   so `docker inspect ghcr.io/<owner>/phoenix:1.0.0` (or any running
   container from it) reports exactly which release it is, independent of
   which tag someone pulled it by.
4. A plain local `docker build .` with no `--build-arg VERSION=...` still
   works exactly as before and labels itself `"dev"` — nothing about local,
   non-release builds changed.
5. `scripts/build-testops-mobile.sh` (the no-registry file-handoff path
   from `docs/TESTOPS_MOBILE_DOCKER.md`) is unaffected and still exists
   for a team with no access to `ghcr.io/<owner>/phoenix` at all — the two
   publish paths are independent, not a replacement of one by the other.

## Why GitHub Container Registry, and why this doesn't need a new secret

GitHub Actions already provides a short-lived `GITHUB_TOKEN` to every
workflow run, and that token is sufficient to push to `ghcr.io` for the
repo it ran in (via the `packages: write` permission declared in the
workflow) — nothing had to be fabricated or requested to make this real.
If/when TestOps stands up its own registry instead (ECR, Harbor, Docker
Hub, GCR), `docker-publish.yml`'s login + push steps are the only two
places that change — the build step, the version scheme, and the
Dockerfile's `VERSION` arg are all registry-agnostic.

## Base image pinning

`Dockerfile`'s `FROM` line is pinned to `node:20.18.1-slim` — an exact
upstream version tag, not the floating `node:20-slim` tag that can
silently point at a different image (a new Debian point release, a new
Node 20.x patch) between two builds of the same commit. This sandbox
couldn't resolve and record the actual content digest behind that tag
(outbound registry access is blocked here — the same constraint noted
above), so it isn't pinned by digest yet. The strongest version of this
pin is `node:20.18.1-slim@sha256:<digest>`; whoever runs the first real
build with registry access should resolve that digest
(`docker pull node:20.18.1-slim && docker inspect --format
'{{index .RepoDigests 0}}' node:20.18.1-slim`) and update the `FROM` line
to include it, bumping the tag and digest together on purpose from then
on, never the digest alone.

## What's still genuinely open

- **No real push has been executed.** This is implemented, not proven —
  see the status line at the top.
- **No automatic regression gate before a tag is pushed.** `test.yml`
  still runs on every push/PR; `docker-publish.yml` does not re-run the
  test suite itself before pushing (it trusts that a tag is only cut from
  a commit that already passed CI on `main`). Worth tightening to a
  `needs:`/required-check dependency once the publish path has a few real
  runs behind it.
- **Digest pinning** for the base image, per the section above.
