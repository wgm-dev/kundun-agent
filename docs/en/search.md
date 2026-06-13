# Search

Kundun-Agent indexes your codebase into searchable chunks so that you (or an AI
agent) can find relevant code by keyword without scanning the whole repository.
This page explains the two search backends — **FTS5** and the **LIKE** fallback
— how to tell which one is active, the `kundun search` command and its flags,
what a result looks like, and the provider abstraction behind it.

Before you can search, the project must be initialized and scanned:

```bash
kundun init
kundun scan
```

`scan` walks the project, indexes text files into line-range chunks, and (when
available) keeps the full-text index up to date. See
[Scanner & indexing](scanner-indexing.md) for how chunks are produced.

## FTS5 primary vs LIKE fallback

Search has two backends and picks the best one available at runtime:

- **`fts5`** — the primary backend. It uses SQLite's FTS5 virtual table
  (`chunks_fts`) with **bm25 ranking**, so the most relevant chunks rank first.
  The `better-sqlite3` build that ships with Kundun-Agent has FTS5 enabled, so
  this is the normal path.
- **`like`** — the fallback backend. When FTS5 is unavailable, search degrades
  to a SQL `LIKE` scan over the indexed chunks. It still returns matches but
  without bm25 relevance ranking.

There are **no external embeddings** in MVP 1. All search is local and runs
against your SQLite database.

## Telling which mode is active

Every search prints a footer showing the active mode, either `fts5` or `like`:

```bash
kundun search "rate limit"
```

```text
src/middleware/throttle.ts:42
  if (this.exceeded(key)) throw new RateLimitError(key);

config/limits.ts:8
  export const RATE_LIMIT_PER_MINUTE = 120;

(search mode: fts5)
```

The footer is your ground truth: if it says `fts5`, you are getting bm25
ranking; if it says `like`, FTS5 was not available and results are unranked.

With `--json`, the mode is part of the machine-readable payload on stdout (all
logs go to stderr, so stdout stays clean JSON):

```bash
kundun search "rate limit" --json
```

## The `search` command

```text
kundun search <query> [--language <language>] [--limit <n>]
```

- `<query>` — the text to search for (required).
- `--language <language>` — restrict results to a single language (see the list
  below).
- `--limit <n>` — cap the number of results returned.

Global options apply too: `--project-root <path>`, `--json`, `-V`/`--version`,
`-h`/`--help`.

### Examples

Search everything:

```bash
kundun search "createUser"
```

Restrict to one language:

```bash
kundun search "SELECT" --language sql
```

Limit the number of hits:

```bash
kundun search "middleware" --limit 5
```

Combine flags:

```bash
kundun search "Repository" --language php --limit 10
```

### Supported languages for `--language`

`--language` accepts any of the indexed languages:

| Language   | Value        | Extensions                                 |
| ---------- | ------------ | ------------------------------------------ |
| PHP        | `php`        | `.php`                                     |
| Go         | `go`         | `.go`                                      |
| TypeScript | `typescript` | `.ts` `.tsx` `.mts` `.cts`                 |
| JavaScript | `javascript` | `.js` `.jsx` `.mjs` `.cjs`                 |
| C#         | `csharp`     | `.cs`                                      |
| C/C++      | `cpp`        | `.cpp` `.cc` `.cxx` `.hpp` `.hh` `.h` `.c` |
| SQL        | `sql`        | `.sql`                                     |

## What a result looks like

Each result is printed as `relativePath:line` followed by a snippet of the
matching code:

```text
src/services/payment-service.ts:118
  async function refund(orderId: string, amount: Money) {
```

- **`relativePath`** is relative to the project root, so paths are stable across
  machines.
- **`line`** is the 1-based line where the match was found.
- The snippet is the surrounding chunk text, drawn from the line-range chunks
  produced during indexing.

Results are followed by the `(search mode: …)` footer described above.

> Search only covers **indexed content**. Sensitive files (such as `.env`,
> `*.pem`, `*.key`, and anything under `**/secrets/**`) are skipped during
> scanning and their content is never stored, so they can never appear in
> search results. Binary files and files larger than `maxFileSizeKb` are also
> not indexed. See [Scanner & indexing](scanner-indexing.md).

## The provider abstraction

Search is built on a small provider interface so the backend can change without
affecting the `search` command. MVP 1 ships three providers:

- **`sqlite-fts-provider`** — the primary provider, backed by the FTS5
  `chunks_fts` table with bm25 ranking.
- **`fallback-search-provider`** — the `LIKE`-based provider used when FTS5 is
  unavailable.
- **`future-embedding-provider`** — a **stub** that reserves a place for
  semantic / embedding-based search in a later milestone. It is **not active in
  MVP 1** and performs no external calls. Search stays fully local.

At runtime, Kundun-Agent selects `sqlite-fts-provider` when FTS5 is available
and falls back to `fallback-search-provider` otherwise — which is exactly what
the `fts5` / `like` footer reflects.

## Related: finding symbols

When you want a named definition rather than a keyword match, use `symbol`
instead of `search`:

```bash
kundun symbol UserController --kind class
kundun symbol handle --prefix
```

`symbol` looks up extracted symbols by exact name (or by prefix with
`--prefix`) and supports `--language`, `--kind`, and `--limit`. See the
[CLI reference](cli-reference.md) for full details.

## See also

- [Documentation hub](../README.md)
- [Scanner & indexing](scanner-indexing.md) — how files become searchable chunks
- [CLI reference](cli-reference.md) — full command and flag reference
