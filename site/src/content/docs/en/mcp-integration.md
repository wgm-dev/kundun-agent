---
title: MCP Integration (Claude Code, Codex, Cursor…)
description: Kundun-Agent ships an MCP server so MCP-compatible coding agents can call its indexing, search, memory, task, diagnostics, and summary features as tools.
---

Kundun-Agent ships an **MCP server** so MCP-compatible coding agents can call its
indexing, search, memory, task, diagnostics, and summary features as tools. The
server speaks the Model Context Protocol over **stdio**.

## 1. Build the project

```bash
npm install
npm run build
```

This produces the CLI at `dist/cli/index.js`. The MCP server is started by the
`kundun mcp` subcommand.

## 2. Initialize your project once

The MCP server operates on an **initialized** project (it needs `.kundun/` and
the SQLite database). In the project you want indexed:

```bash
node /abs/path/to/kundun-agent/dist/cli/index.js --project-root . init
node /abs/path/to/kundun-agent/dist/cli/index.js --project-root . scan
```

(If you `npm link` the package, you can use `kundun init` / `kundun scan`.)

## 3. Add it to Claude Code

Add an entry to your MCP servers configuration. The server runs over stdio, so
the command is `node <dist/cli/index.js> mcp`. Point `--project-root` at the
project you want Kundun to operate on:

```json
{
  "mcpServers": {
    "kundun-agent": {
      "command": "node",
      "args": [
        "/abs/path/to/kundun-agent/dist/cli/index.js",
        "--project-root",
        "/abs/path/to/your/project",
        "mcp"
      ]
    }
  }
}
```

On Windows, use escaped backslashes in JSON:

```json
{
  "mcpServers": {
    "kundun-agent": {
      "command": "node",
      "args": [
        "E:\\github-project\\kundun-agent\\dist\\cli\\index.js",
        "--project-root",
        "C:\\path\\to\\your\\project",
        "mcp"
      ]
    }
  }
}
```

> The global `--project-root` flag must come **before** the `mcp` subcommand, as
> shown. If omitted, the server uses the current working directory.

After saving the config, restart Claude Code. The `kundun-agent` server should
connect and expose its tools.

## 4. Available tools

The server registers **18 tools** (see the
[full spec](https://github.com/wgm-dev/kundun-agent/blob/main/README.md) §18 for input shapes):

| Tool                             | Purpose                                                               |
| -------------------------------- | --------------------------------------------------------------------- |
| `kundun.scan_project`            | Scan and index new/changed files                                      |
| `kundun.search_code`             | Search indexed code (FTS5 or LIKE)                                    |
| `kundun.get_file_context`        | File metadata + chunks + symbols + related memories/tasks/diagnostics |
| `kundun.find_symbol`             | Find classes/functions/methods by name                                |
| `kundun.add_memory`              | Store a project memory                                                |
| `kundun.search_memory`           | Search memories                                                       |
| `kundun.list_important_memories` | List the most important memories                                      |
| `kundun.create_task`             | Create a task                                                         |
| `kundun.next_task`               | Get the next actionable task                                          |
| `kundun.update_task`             | Update a task                                                         |
| `kundun.run_diagnostics`         | Run heuristic diagnostics                                             |
| `kundun.cleanup`                 | Apply the retention policy (supports `dryRun`)                        |
| `kundun.project_summary`         | High-level project overview                                           |
| `kundun.get_sessions`            | Active and recent client sessions                                     |
| `kundun.get_health`              | Computed health snapshot                                              |
| `kundun.get_metrics`             | Computed metrics from current counts                                  |
| `kundun.get_recent_events`       | Recent in-memory events                                               |
| `kundun.restart_daemon`          | Disabled unless `allowRestartFromMcp` is true                         |

## 5. Available resources

The server also exposes **8 read-only resources**:

```
kundun://project/summary
kundun://project/memories
kundun://project/tasks
kundun://project/diagnostics
kundun://project/recent-changes
kundun://project/sessions
kundun://project/health
kundun://project/metrics
```

## 6. Notes & troubleshooting

- **stdout is reserved for the protocol.** All logs go to stderr, so never pipe
  the server's stdout anywhere but the MCP client.
- **"Kundun is not initialized"** — run `init` and `scan` in the project root
  (step 2) before starting the server.
- **No content leaves your machine.** The server is local-first; sensitive files
  are skipped and their content is never stored or returned.
- **Sessions, health, metrics, and events are live.** The server registers a
  session on connect and instruments every tool call, so `get_sessions`,
  `get_health`, `get_metrics`, and `get_recent_events` return real data. For
  periodic metrics snapshots, background scans, and the web dashboard, also run
  `kundun daemon` (see the [Web dashboard](/en/dashboard/) guide).

## See also

- [Documentation hub](/en/)
- [CLI reference](/en/cli-reference/)
- [Security](/en/security/)
