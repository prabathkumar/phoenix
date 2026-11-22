# MCP server for ILMU Code

Lets ILMU Code (or any MCP client) start the AI team, unit tests and scans through the Release API (`docs/RELEASE_API.md`). Every Release API check still applies. No extra packages: plain Python.

## Tools
| Tool | What it does |
|---|---|
| `testops_start_release` | whole team on a release |
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
