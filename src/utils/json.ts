// JSON helpers used for serializing/deserializing TEXT columns (e.g. tags,
// related_files, related_memories) that store JSON arrays. No dependencies.

/**
 * Parse a JSON string, returning `fallback` on null/undefined input or any
 * parse error. The parsed value is returned as-is and is NOT validated against
 * the shape of `fallback`.
 */
export function safeParse<T>(s: string | null | undefined, fallback: T): T {
  if (s == null) {
    return fallback;
  }
  try {
    return JSON.parse(s) as T;
  } catch {
    return fallback;
  }
}

/**
 * Parse a JSON array of strings. Returns [] on null/undefined input, parse
 * failure, or if the parsed value is not an array of strings.
 */
export function parseStringArray(s: string | null | undefined): string[] {
  if (s == null) {
    return [];
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(s);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed) || !parsed.every((item) => typeof item === 'string')) {
    return [];
  }
  return parsed;
}

/**
 * Serialize an array of strings to a JSON string.
 */
export function stringifyArray(a: readonly string[]): string {
  return JSON.stringify(a);
}
