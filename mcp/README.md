# Phoenix MCP connector

A standard MCP server (stdio transport) exposing Phoenix's own data to
an external MCP client -- built for the user's TestOps MCP (ahead of
its own Claude-marketplace integration) to pull from, but usable by
any MCP client (Claude Code, Claude Desktop, etc).

This does **not** touch or require Phoenix's internal Ollama resolver
to support tool-calling -- that's a separate, internal direction
(`generation/llm.js` calling Ollama's plain `/api/generate`). This
server is the other, external-facing direction: a client calls IN to
Phoenix, not Phoenix calling out to a model via MCP.

## Setup

```bash
cd mcp
npm install
```

## Run

```bash
node server.js
```

It speaks stdio MCP -- run it from an MCP client config (e.g. your
TestOps MCP's own config, or Claude Desktop's `claude_desktop_config.json`),
not interactively in a terminal. Example client config entry:

```json
{
  "mcpServers": {
    "phoenix": {
      "command": "node",
      "args": ["/absolute/path/to/phoenix/mcp/server.js"],
      "env": {
        "PHOENIX_MCP_ALLOW_RUN": "0"
      }
    }
  }
}
```

## Tools exposed

- `get_locator_history` -- confidence/drift history for one test case's locators
- `get_suite_health` -- rollup: how many steps are unverified, which have drifted most
- `list_test_cases` -- test-cases/*.json files and their step counts
- `get_test_case` -- one test case's full parsed steps
- `get_recent_executions` -- recent training-log records (never includes typed secret values)
- `run_test_case` -- **spends a real device session**. Disabled unless the server
  process has `PHOENIX_MCP_ALLOW_RUN=1` set, and every call must also pass
  `confirm: true`. Never accepts a credential argument -- those must already be
  configured in the server's own environment (its `.env`), exactly like running
  `run-batch-executions.js` directly.

## Tests

```bash
npm test
```
