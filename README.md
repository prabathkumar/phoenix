# Phoenix

Proprietary mobile test-recording and generation engine for TestOps.

Testers record a flow once, inside TestOps — no Appium Inspector, no local install, no separate device-farm dashboard. Phoenix captures the session and generates a working automated script.

Built on a fork of Appium's core engine (Apache 2.0), extended with an AI-native layer Appium doesn't have.

See [`docs/PHOENIX_SPEC.md`](docs/PHOENIX_SPEC.md) for the full architecture and roadmap.

## Repo layout

| Directory | Purpose |
|---|---|
| `engine/` | Forked Appium core + drivers (Android/iOS), stripped to session + driver essentials |
| `capture/` | Records taps, accessibility-tree snapshots, and screenshots during a session |
| `generation/` | Turns a captured session into a named, asserted, parameterized script |
| `live-view/` | Embeddable component: streams the device screen and forwards taps into TestOps |
| `docs/` | Architecture, spec, and decision records |

## Status

Stage 0 — repo scaffolding in place. Appium source vendoring and the first working single-session milestone (launch app → screenshot → read tree → inject tap) are next.
