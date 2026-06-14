# Web Dashboard

The **Kundun Control Center** is a small web UI for the local daemon. It is a set
of static files (plain HTML, CSS, and vanilla JavaScript — no framework, no build
step) bundled with the package and served by the local HTTP API itself, so you get
a UI without any extra toolchain.

The UI shell is public; the **data** it shows still requires the API token. You
paste the token into the page once and the UI sends it as a `Bearer` header on
every data request (and as `?token=` on the WebSocket event stream).

## Quick start

1. **Start the daemon** from your project root:

   ```bash
   kundun daemon
   ```

   The daemon prints the API URL and the dashboard URL:

   ```text
   Kundun daemon listening on http://127.0.0.1:37373
   Dashboard: http://127.0.0.1:37373/
   Paste the token from .kundun/runtime/token in the UI to unlock data.
   pid 12345 — Ctrl+C to stop
   ```

2. **Open the dashboard** in a browser:
   [http://127.0.0.1:37373/](http://127.0.0.1:37373/)

   The default port is `37373` (configurable via `desktop.localApiPort`).

3. **Paste the token.** Open `.kundun/runtime/token` in your project, copy the
   single-line token, and paste it into the field at the top of the dashboard.
   The token is generated on the daemon's first run and stored with restricted
   permissions; it is never logged. With the token set, the data panels unlock.

## What the dashboard shows

- **Health** — the computed health status and recent health events.
- **Sessions** — registered agent/tool sessions and their state.
- **Metrics** — the latest metrics snapshot for the project.
- **Live events** — a stream of events pushed over the WebSocket (`/events`) as
  scans, cleanups, and health changes happen.
- **Actions** — token-gated buttons to trigger a scan, cleanup, or diagnostics
  run, and to restart the MCP server in process.

## Security notes

- The local API (and therefore the dashboard) binds to loopback only
  (`127.0.0.1` / `::1`). It refuses to bind to any other address.
- Loopback origin is enforced for every request and WebSocket upgrade, before
  authentication.
- The static dashboard is sandboxed to its own directory: path traversal,
  absolute escapes, and NUL bytes are rejected, there is no directory listing,
  and only `GET`/`HEAD` are served. `/` serves `index.html`.
- Read endpoints are public except `/logs`; all mutating actions and the
  WebSocket require the token.

## Running without the dashboard

If you only want the API and not the static UI, start the daemon with
`--no-dashboard`:

```bash
kundun daemon --no-dashboard
```

Static serving is then disabled entirely and the API routes still work as usual.

## See also

- [Documentation hub](../README.md)
- [Getting started](getting-started.md)
- [Configuration](configuration.md)
- [Security](security.md)
