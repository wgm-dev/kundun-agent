# Documentation contribution & translation-sync policy

Kundun-Agent ships bilingual end-user documentation: **English** (`docs/en/`)
and **Brazilian Portuguese** (`docs/pt-BR/`). This document defines how to keep
the two trees in sync.

## Layout

- Every page exists with the **same filename** in both `docs/en/` and
  `docs/pt-BR/`.
- The hub [`docs/README.md`](README.md) holds the bilingual table of contents.
- Code, code comments, and the developer guide [`CLAUDE.md`](../CLAUDE.md) are
  English-only (see CLAUDE.md §1).

## The golden rule

> **A user-facing change must update both languages in the same change.**

If you genuinely cannot produce both at once:

1. Make the change in the language you can write.
2. Add a banner at the **top** of the other language's page:
   ```md
   > ⚠️ **Translation pending.** This page is behind the English/Portuguese
   > version. See the other language until this is updated.
   ```
3. Open a follow-up issue/task so the trees do not silently diverge.

## Style

- Keep section headings parallel across languages so cross-references line up.
- Do **not** translate: command names, flags, code identifiers, file paths,
  config keys, SQL, or output samples. Translate only prose.
- Prefer short, task-oriented sections with runnable examples.
- Wrap prose at ~100 columns to match the repo's Prettier setting.

## Source of truth

When prose and code disagree, **code wins** — update the docs. The canonical
behavior is whatever `src/` does and `tests/` assert. The full product
specification is in the root [`README.md`](../README.md).
