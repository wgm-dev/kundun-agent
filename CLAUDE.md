# CLAUDE.md — Project rules & navigation for Kundun-Agent

This file orients any AI coding agent (or human) working in this repository.
Read it before making changes. It encodes the project's rules, a map of the
codebase, and step-by-step recipes for adding new functionality.

> **Language policy:** All **code, code comments, identifiers, commit messages,
> and this file** are in **English**. End-user **documentation** is bilingual
> (`docs/pt-BR/` and `docs/en/`) — see [Adding/maintaining docs](#recipe-add-docs).

---

## 1. What this project is

Kundun-Agent is a **local-first project intelligence layer for coding agents**:
it indexes a codebase, stores persistent memory, tracks tasks, runs cleanup, and
serves agent-friendly context — all locally with SQLite. See the full spec in
[`README.md`](README.md) (§1–§35).

**Current milestones: MVP 1 + MVP 2 are implemented.** MVP 1 is the local core
(CLI, SQLite storage, config, incremental scanner, indexer + chunker,
FTS5/`LIKE` search, memory engine, task engine, auto-cleanup). MVP 2 adds the
**MCP server** (18 tools + 8 resources over stdio, started by `kundun mcp`),
**heuristic diagnostics** (`kundun diagnostics`), and an in-memory **event bus**.

**Out of scope until later milestones** (do not implement unless asked): daemon,
session registry, health/metrics persistence (`metrics_snapshots`/`health_events`
tables — current `get_health`/`get_metrics` are computed, not stored), local HTTP
API + WebSocket, and the Go+Wails desktop app.

---

## 2. Non-negotiable rules

These are enforced by CI (`typecheck`, `lint`, `format:check`, `test`). A change
that breaks any of them is not done.

1. **ESM + NodeNext.** Every relative import **must** end with `.js`
   (e.g. `import { nowIso } from '../utils/time.js'`), even though the source is
   `.ts`. Type-only imports use `import type` (`verbatimModuleSyntax` is on).
2. **TypeScript strict superset.** `strict` + `noUncheckedIndexedAccess` +
   `exactOptionalPropertyTypes`. Array/record lookups are `T | undefined` —
   narrow them. Never assign `undefined` to an optional prop; omit the key.
3. **`better-sqlite3` is synchronous.** Do **not** wrap DB calls in
   `async`/`await`. No floating/misused promises (ESLint errors).
4. **Comments and identifiers in English.** Keep them; do not translate code.
5. **Timestamps come from one place.** Only [`src/utils/time.ts`](src/utils/time.ts)
   produces ISO-8601 UTC strings. Age/expiry comparisons rely on lexicographic
   ISO ordering — never hand-format a date elsewhere.
6. **Security is load-bearing.** All filesystem access goes through
   [`src/utils/path-safety.ts`](src/utils/path-safety.ts) (root containment,
   traversal block, per-segment symlink guard). Sensitive files
   (`.env`, `*.pem`, `*.key`, secrets…) are classified in
   [`src/utils/ignore-rules.ts`](src/utils/ignore-rules.ts) and **never have
   their content stored** — only a path + hash row for deletion tracking.
7. **No overengineering.** Simple, testable, modular. No abstraction without a
   second concrete caller.
8. **Pin `better-sqlite3` at `^12.x`.** The 11.x line has no Node 24 / ABI-137
   prebuilt binary and falls back to compiling via node-gyp (needs MSVC, which
   is not installed on the dev machine).

---

## 3. Commands

```bash
npm install          # installs deps (better-sqlite3 fetches a prebuilt binary)
npm run build        # tsup -> dist/ (ESM + .d.ts; better-sqlite3 stays external)
npm test             # vitest run (unit + integration)
npm run test:watch   # vitest watch
npm run typecheck    # tsc --noEmit
npm run lint         # eslint .
npm run lint:fix     # eslint . --fix
npm run format       # prettier --write .
npm run format:check # prettier --check .
```

**Definition of done for any change:** `typecheck`, `lint`, `format:check`, and
`test` all pass, and `build` succeeds.

---

## 4. Codebase map (by layer)

Dependencies flow **downward**: a layer may import from layers above it, never
below. This is why the build order in §6 matters.

```
src/
  index.ts                     # library entry (public re-exports)

  utils/                       # LEAF layer — no internal deps (except each other)
    time.ts                    # ISO-8601 clock (single source of timestamps)
    json.ts                    # safe JSON parse / string-array helpers
    errors.ts                  # KundunError + KundunErrorCode union
    logger.ts                  # ndjson logger -> stderr (+ optional log files)
    hashing.ts                 # sha256 helpers (file/chunk content hashing)
    binary-detection.ts        # NUL/control-char + extension binary sniffing
    path-safety.ts             # SECURITY: root containment, traversal, symlinks
    ignore-rules.ts            # include/exclude (picomatch) + .gitignore + sensitive

  config/                      # depends on: utils
    config-schema.ts           # zod schema -> KundunConfig (mirrors README §10)
    default-config.ts          # buildDefaultConfig(name)
    config-loader.ts           # load/write/exists; resolves db path safely

  storage/                     # depends on: utils, config
    types.ts                   # row types + KundunDb + enum literal unions
    sqlite.ts                  # openDatabase (PRAGMAs), hasFts5 probe, transaction
    migrations.ts              # _migrations table (authoritative) + v1 schema
    repositories/              # one file per table group; prepared statements
      meta.repository.ts       # project_meta
      run.repository.ts        # scan_runs + cleanup_runs
      file.repository.ts       # files (upsert/change-detect/markDeleted/deleteHard)
      chunk.repository.ts      # file_chunks (+ chunks_fts) -> ChunkHit
      symbol.repository.ts     # symbols -> SymbolHit
      memory.repository.ts     # memories (+ memories_fts), archived_at
      task.repository.ts       # tasks (+ next-task CASE ordering)

  core/                        # depends on: utils, config, storage
    language-detector.ts       # extension -> SupportedLanguage
    importance.ts              # 0..100 scale, HIGH_IMPORTANCE_THRESHOLD=80
    chunker.ts                 # pure line-range chunking
    search-provider.ts         # SearchProvider interface + factory (fts5|like)
    sqlite-fts-provider.ts     # FTS5 implementation
    fallback-search-provider.ts# LIKE implementation
    future-embedding-provider.ts# stub for a future milestone
    project-scanner.ts         # incremental safe walk -> ScanResult
    indexer.ts                 # chunk + symbols + importance per file
    memory-engine.ts           # memory CRUD + bounded promotion-on-use
    task-engine.ts             # task CRUD + next()
    cleanup-engine.ts          # dry-run/real retention; VACUUM after commit
    project-summary.ts         # read-only aggregate for `summary`
    diagnostics-engine.ts      # MVP2: heuristic diagnostics runner
    diagnostics/rules.ts       # MVP2: per-language regex rules (no code execution)
    event-bus.ts               # MVP2: in-memory event bus
    container.ts               # COMPOSITION ROOT: createAppContext + build* helpers

  mcp/                         # MVP2: depends on core + storage (top layer, like cli)
    server.ts                  # startMcpServer over stdio (shared AppContext)
    tools.ts                   # registerTools: 18 kundun.* tools
    resources.ts               # registerResources: 8 kundun://project/* resources

  languages/                   # depends on: storage/types only
    index.ts                   # EXTRACTORS registry + getExtractor(lang)
    {typescript,javascript,php,go,csharp,cpp,sql}.ts  # regex symbol extractors

  cli/                         # depends on: everything (top layer)
    index.ts                   # commander program; global --project-root/--json
    shared.ts                  # arg parsing + AppContext helpers + output helpers
    commands/                  # one file per command; export register<Name>Command
      {init,scan,search,symbol,memory,task,cleanup,summary,diagnostics,mcp}.ts

tests/
  helpers/                     # test-db (temp-file sqlite), temp-project, clock, logger
  unit/                        # utils, config, storage, core
  integration/                 # scanner-incremental, cleanup-engine
```

**Composition root.** Every CLI command gets its wiring from
[`src/core/container.ts`](src/core/container.ts): `createAppContext({projectRoot})`
loads config, opens the DB, runs migrations, builds all repositories, and returns
an `AppContext` plus `build*` factories (`buildScanner`, `buildIndexer`,
`buildMemoryEngine`, `buildTaskEngine`, `buildCleanupEngine`,
`buildSearchProvider`). Always `ctx.close()` in a `finally`.

---

## 5. Key invariants (don't break these)

- **Schema version** lives in the `_migrations` table (authoritative);
  `project_meta.schema_version` is a human-readable mirror.
- **FTS5 is detected once** in `sqlite.ts` (`KundunDb.hasFts5`). All `*_fts`
  writes are guarded by it; the search provider factory picks `fts5` or `like`
  from it. Never re-probe.
- **Importance is a 0..100 integer scale.** `HIGH_IMPORTANCE_THRESHOLD = 80`
  (defined once in `core/importance.ts`). Cleanup **never** deletes a memory
  scoring ≥ 80; memory promotion/demotion is bounded and clamped.
- **`memories.archived_at`** is an intentional addition beyond README §9.5.
  Archived memories are excluded from search and `listImportant`.
- **Cleanup dry-run writes nothing** — not even a `cleanup_runs` row.
- **CLI output discipline.** Human text and `--json` payloads go to **stdout**;
  all logs go to **stderr**. `--json` stdout must always be valid JSON.

---

## 6. Recipes — adding new functionality

### Recipe: add a new SQLite table / column

1. Bump `LATEST_SCHEMA_VERSION` in [`migrations.ts`](src/storage/migrations.ts)
   and append a new `Migration` object (forward-only; use `IF NOT EXISTS`).
   Never edit migration v1 in place once released.
2. Add/extend the row type(s) in [`storage/types.ts`](src/storage/types.ts).
3. Create or extend the repository under `storage/repositories/`. Prepare
   statements **once** in the constructor; batch `IN (...)` ops in ≤500 chunks.
4. Add a unit test under `tests/unit/storage/`.

### Recipe: add a new CLI command

1. Create `src/cli/commands/<name>.ts` exporting
   `export function register<Name>Command(program: Command): void`.
2. Inside the action: read globals via `program.optsWithGlobals()`, call
   `createAppContext({ projectRoot })`, do work via a `build*` factory, print
   human output (picocolors) or `JSON.stringify` when `--json`, and
   `ctx.close()` in `finally`. Errors → stderr + `process.exitCode = 1`; map
   `KundunError('not_initialized')` to a "run `kundun init`" hint.
3. Register it in [`src/cli/index.ts`](src/cli/index.ts).
4. Add the command to **both** CLI references: `docs/pt-BR/cli-reference.md` and
   `docs/en/cli-reference.md`.

### Recipe: add a new core engine/feature

1. Put the logic in `src/core/<feature>.ts` as a `create<Feature>(deps)` factory
   that takes its repositories/clock via `deps` (inject `now?: () => string` for
   anything time-dependent so tests can control the clock).
2. Wire a `build<Feature>(ctx)` helper in `container.ts`.
3. New feature = isolated module; do not bolt onto an unrelated file.
4. Unit-test the engine with the temp-file DB helper.

### Recipe: add a new language symbol extractor

1. Add `src/languages/<lang>.ts` exporting
   `export function extract<Lang>Symbols(content: string, fileId: number): NewSymbolRow[]`.
   Regex/heuristic only — **never execute code**, never throw (catch internally,
   return `[]`).
2. Register it in `src/languages/index.ts` and map its extension(s) in
   `core/language-detector.ts` (and the `SupportedLanguage` union in
   `storage/types.ts` if it's a brand-new language).

<a id="recipe-add-docs"></a>

### Recipe: add or change end-user documentation (bilingual)

- Docs live in `docs/pt-BR/` and `docs/en/` with **mirrored filenames**.
- Any user-facing change must update **both** language versions in the same
  change. If you can only write one, add a `> ⚠️ Translation pending` note at the
  top of the other and open a follow-up — never let the trees silently diverge.
- The hub [`docs/README.md`](docs/README.md) links both languages; keep its
  table of contents in sync when adding a page.
- See [`docs/CONTRIBUTING-DOCS.md`](docs/CONTRIBUTING-DOCS.md) for the full
  translation-sync policy.

---

## 7. Where to look first

| I want to…                          | Start here                                                                  |
| ----------------------------------- | --------------------------------------------------------------------------- |
| Understand the whole spec           | [`README.md`](README.md)                                                    |
| Understand how things wire together | `src/core/container.ts`                                                     |
| Add a command                       | `src/cli/commands/` + Recipe above                                          |
| Touch the schema                    | `src/storage/migrations.ts` + `src/storage/types.ts`                        |
| Understand security guarantees      | `src/utils/path-safety.ts`, `ignore-rules.ts`, [`SECURITY.md`](SECURITY.md) |
| Read user docs                      | [`docs/README.md`](docs/README.md)                                          |
