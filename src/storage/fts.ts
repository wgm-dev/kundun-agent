// Shared helpers for safely querying SQLite FTS5 and LIKE from user input.
// Centralizing these keeps every repository's search path consistently
// injection-proof: raw user text must never reach an FTS5 MATCH or a LIKE
// pattern unescaped (it would either error out or, worse, act as an operator).

/**
 * Turn arbitrary user input into a safe FTS5 MATCH expression. Each whitespace
 * separated term is wrapped in double quotes (with inner quotes doubled),
 * neutralizing FTS operators (`*`, `-`, `:`, `NEAR`, parentheses, etc.). Terms
 * are AND-combined by juxtaposition.
 *
 * When `prefix` is true, the LAST term additionally gets a trailing `*` so the
 * query matches tokens that *start with* that term (e.g. `Payment` matches
 * `PaymentService`). This makes interactive/agent searches forgiving without
 * letting the user inject raw FTS operators.
 *
 * Returns null when no usable term remains (caller should treat as empty).
 */
export function toSafeFtsMatch(query: string, opts?: { prefix?: boolean }): string | null {
  const terms = query
    .split(/\s+/)
    .map((t) => t.trim())
    .filter((t) => t.length > 0)
    // Keep only parts that carry searchable characters; a purely punctuation
    // term yields nothing useful once quoted.
    .filter((t) => /[^\s"]/.test(t));

  if (terms.length === 0) {
    return null;
  }

  const quoted = terms.map((t) => `"${t.replace(/"/g, '""')}"`);
  if (opts?.prefix === true && quoted.length > 0) {
    // A prefix token in FTS5 is `"term"*` — the star sits OUTSIDE the quotes.
    quoted[quoted.length - 1] = `${quoted[quoted.length - 1]!}*`;
  }
  return quoted.join(' ');
}

/** Escape `%`, `_` and `\` for use inside a LIKE pattern with `ESCAPE '\\'`. */
export function escapeLike(query: string): string {
  return query.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}
