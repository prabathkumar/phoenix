# MCP server for ILMU Code

Lets ILMU Code (or any MCP client) start the AI team, unit tests and scans through the Release API (`docs/RELEASE_API.md`). Every Release API check still applies. No extra packages: plain Python.

## Tools
| Tool | What it does |
|---|---|
| `testops_start_release` | whole team on a release |
| `testops_validate_code_and_run_tests` | the full check in order: link repo, Semgrep code quality and secrets, AI checks the code implements the requirement, then unit and integration tests |
| `testops_run_unit_and_integration_tests` | unit tests plus API-layer integration tests, kept apart when run; integration needs `appUrl` |
| `testops_run_unit_tests` | link repo, write unit tests, run them; created in TestOps first, then pushed to Jira |
| `testops_run_scans` | secrets and code-quality scans on a temporary copy of the repo |
| `testops_send_event` | any agent and action, or your own `steps` |
| `testops_get_status` / `testops_get_evidence` | status per agent, and what was created |
| `testops_list_actions` | agents and their actions |

Give a `release` (made by the Head of QA) or a `project`, plus a `jiraKey` or `requirement`, and a `repo` for unit tests and scans. Add `wait: true` to wait for the result.

## Connect it
Create a key once on the server: `python -m phoenix_api.api_keys ilmu-code`. Use a key **without** approve rights, so ILMU Code can never approve a live scan or Jira writes.

Add to the client's MCP settings:
```json
{"mcpServers": {"testops-ai": {"command": "python3", "args": ["-m", "phoenix_mcp.server"], "cwd": "/Users/prabathkumar/android-sdk/cmdline-tools/phoenix/backend",
  "env": {"PHOENIX_URL": "http://localhost:8000", "PHOENIX_API_KEY": "<the key>"}}}}
```
For Claude Code: `claude mcp add testops-ai -e PHOENIX_URL=http://localhost:8000 -e PHOENIX_API_KEY=<the key> -- python3 -m phoenix_mcp.server` (run from the `backend` folder).

## Not tested yet
Against real Jira, GitLab or GitHub, and ILMU Code itself. Tests cover the protocol and the Release API with fakes (`backend/tests/test_mcp_server.py`).

## Order of a full check, and the test-data question
`testops_validate_code_and_run_tests`: link the repo; Semgrep code quality (TestOps name `sast`) and Gitleaks secrets (`secrets`); the AI checks the code against the requirement; it writes unit and integration tests, loaded in TestOps and shown; then the run **stops and asks who creates the test data**: `dataMode generate` (the AI makes mock data) or `dataMode file` (a person loads NAME,VALUE lines or JSON). Values the AI cannot make up (existing accounts, passwords, tokens) always need a file. Only then are the tests loaded into a fresh checkout and run. Answer with `testops_choose_test_data` (API: `POST /api/v1/events/{id}/data`). Pass `dataMode: generate` up front to skip the question.

## Languages and frameworks
JavaScript, TypeScript (Angular with Jasmine/Karma or Jest; NestJS with Jest and @nestjs/testing), Python (pytest, with Django, FastAPI or Flask helpers), Java, Go, C#, PHP, Rust (cargo test; Axum or Actix Web helpers), and Perl (Test::More via prove, only if installed). Frameworks are found from `package.json`, `requirements.txt`/`pyproject.toml` and `Cargo.toml`; a missing toolchain is reported as unavailable, never as a pass. Angular on Karma needs `karma-junit-reporter` for results.
