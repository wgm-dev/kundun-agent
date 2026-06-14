# Installation & MCP client setup

This guide covers installing Kundun-Agent and registering it as an MCP server in
Claude Code, Codex, and the Gemini CLI.

## 1. Install

```bash
# Global install (makes the `kundun` command available anywhere):
npm install -g kundun-agent

# Or run on demand without installing:
npx kundun-agent --help
```

> On Windows, `npm install -g` places the binary in `%APPDATA%\npm` (already on
> PATH). Open a NEW terminal after installing so the `kundun` command is picked
> up.

## 2. Initialize the project (once per project)

The MCP server operates on an **initialized and indexed** project:

```bash
cd /path/to/your/project
kundun init
kundun scan
```

`init` creates `.kundun/` (config + SQLite database). `scan` indexes the code.
Without this step the MCP server returns a "not initialized" error.

## 3. Register as an MCP server

Every example below uses `kundun --project-root <path> mcp`. If the `kundun`
command is not on the client's PATH, swap it for `npx -y kundun-agent` (the
variant is shown in each case). In JSON/TOML config files on Windows, escape
backslashes (`\\`).

### Claude Code

Via the CLI (fastest):

```bash
# Current project only:
claude mcp add kundun-agent -- kundun --project-root "C:\\my\\project" mcp

# For all your projects (user scope):
claude mcp add --scope user kundun-agent -- kundun --project-root "C:\\my\\project" mcp

# npx variant (does not depend on `kundun` being on PATH):
claude mcp add kundun-agent -- npx -y kundun-agent --project-root "C:\\my\\project" mcp
```

Everything after `--` is the stdio server command. Use `--scope project` to write
a versioned `.mcp.json` (shared with your team).

JSON equivalent (`.mcp.json` in the project, or `~/.claude.json` for user scope):

```json
{
  "mcpServers": {
    "kundun-agent": {
      "type": "stdio",
      "command": "kundun",
      "args": ["--project-root", "C:\\my\\project", "mcp"]
    }
  }
}
```

### Codex (OpenAI Codex CLI)

Via the CLI:

```bash
codex mcp add kundun-agent -- kundun --project-root "C:\\my\\project" mcp
```

TOML equivalent (`~/.codex/config.toml`):

```toml
[mcp_servers.kundun-agent]
command = "kundun"
args = ["--project-root", "C:\\my\\project", "mcp"]
```

The table is `[mcp_servers.<name>]`; `command` and `args` are separate. For the
npx variant use `command = "npx"` and
`args = ["-y", "kundun-agent", "--project-root", "C:\\my\\project", "mcp"]`.

### Gemini CLI (Google)

Via the CLI (note: Gemini does **not** use the `--` separator):

```bash
gemini mcp add kundun-agent kundun --project-root "C:\\my\\project" mcp
```

JSON equivalent (`~/.gemini/settings.json` or `.gemini/settings.json`):

```json
{
  "mcpServers": {
    "kundun-agent": {
      "command": "kundun",
      "args": ["--project-root", "C:\\my\\project", "mcp"],
      "timeout": 600000
    }
  }
}
```

## 4. Verify

Restart the client and ask it to list the MCP tools. You should see the 18
`kundun.*` tools (code search, memory, tasks, diagnostics, health…). See what
each one does in the [MCP integration](mcp-integration.md) guide.

## Differences at a glance

| Client      | CLI                                 | Config file                    | Uses `--`? |
| ----------- | ----------------------------------- | ------------------------------ | ---------- |
| Claude Code | `claude mcp add name -- kundun ...` | `.mcp.json` / `~/.claude.json` | Yes        |
| Codex       | `codex mcp add name -- kundun ...`  | `~/.codex/config.toml`         | Yes        |
| Gemini CLI  | `gemini mcp add name kundun ...`    | `~/.gemini/settings.json`      | No         |

## Troubleshooting

- **`'kundun' is not recognized`** — you installed locally (in a project), not
  globally. Run `npm install -g kundun-agent` and open a new terminal. Or use the
  `npx -y kundun-agent ...` variant in your config, which does not rely on PATH.
- **The client can't find the `kundun` command** — some launchers have their own
  PATH. Use the `npx` variant (above) or point at the binary's absolute path.
- **"Kundun is not initialized"** — run `kundun init` and `kundun scan` in the
  project root before starting the server.
- **First `npx` run is slow** — npx downloads the package the first time;
  increase the client's timeout if needed.

## See also

- [Documentation hub](../README.md)
- [MCP integration (the 18 tools)](mcp-integration.md)
- [Web dashboard](dashboard.md)
- [Getting started](getting-started.md)
