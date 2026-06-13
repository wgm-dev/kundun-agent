# Security Policy

## Reporting a vulnerability

If you discover a security vulnerability in Kundun-Agent, please report it
privately. Do not open a public issue for security-sensitive reports.

- Email the maintainers with a description, reproduction steps, and impact.
- Allow reasonable time for a fix before any public disclosure.

## Security model

Kundun-Agent is designed to be local-first and conservative by default:

- No project content is sent to external APIs by default.
- The tool does not execute project code, and does not execute arbitrary
  commands on behalf of an agent.
- The scanner never reads files outside the project root, blocks path
  traversal, and does not follow symlinks by default.
- Sensitive files (for example `.env`, `*.pem`, `*.key`, secrets, credentials)
  are skipped during indexing. The tool may record that such a file exists and
  its hash for change tracking, but never stores its content.
- The optional local API (later milestones) binds only to `127.0.0.1` and
  requires a local token for mutating routes.

## Supported versions

During the `0.x` series, only the latest released minor version receives
security fixes.
