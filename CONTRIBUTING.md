# Contributing to Kundun-Agent

Thanks for your interest in contributing. This document covers the basics for
working on the project locally.

## Development setup

```bash
npm install
npm run build
npm test
```

Requirements:

- Node.js 20+ (the project is developed and tested on Node 20 through 24).
- A C/C++ toolchain is generally not required because `better-sqlite3` ships
  prebuilt binaries for supported Node ABIs.

## Workflow

1. Create a branch from `main`.
2. Make your change with tests.
3. Run the full check suite before opening a PR:

   ```bash
   npm run typecheck
   npm run lint
   npm test
   npm run build
   ```

4. Keep changes focused and small.

## Code style

- Code comments must be in English.
- Prefer simple, testable, modular code. Avoid unnecessary abstractions.
- Formatting is handled by Prettier (`npm run format`). Linting is handled by
  ESLint (`npm run lint`). CI enforces both.
- TypeScript runs in strict mode; relative imports use explicit `.js`
  extensions (NodeNext module resolution).

## Reporting issues

Open a GitHub issue with a clear description, reproduction steps, and the
relevant environment details (OS, Node version, Kundun-Agent version).
