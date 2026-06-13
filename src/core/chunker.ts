// Line-window chunker (PURE, no I/O). Splits normalized text into fixed-size
// windows of source lines for storage in file_chunks. Line numbers are 1-based
// and inclusive. Defined once here; consumers import from '../core/chunker.js'.

/** Rough token estimate: ~4 characters per token. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/** Normalize CRLF and lone CR line endings to LF. */
export function normalizeNewlines(text: string): string {
  return text.replace(/\r\n?/g, '\n');
}

/** A contiguous window of source lines. Line numbers are 1-based inclusive. */
export interface Chunk {
  chunkIndex: number;
  content: string;
  startLine: number;
  endLine: number;
  tokenEstimate: number;
}

/** Options for {@link chunkByLines}. */
export interface ChunkByLinesOptions {
  /** Maximum lines per chunk window. Default 200. Coerced to >= 1. */
  maxLines?: number;
  /** Lines re-shared between consecutive windows. Default 0. Coerced to [0, maxLines-1]. */
  overlap?: number;
}

const DEFAULT_MAX_LINES = 200;
const DEFAULT_OVERLAP = 0;

/**
 * Split content into windows of at most `maxLines` lines, optionally overlapping
 * consecutive windows by `overlap` lines. Newlines are normalized first; the text
 * is then split on '\n'. startLine/endLine are 1-based inclusive and each chunk's
 * content is the joined slice of lines.
 *
 * Empty or whitespace-only input returns []. Content with no trailing newline is
 * handled the same as any other line. If everything fits in one window, a single
 * chunk spanning lines 1..N is returned.
 */
export function chunkByLines(content: string, opts?: ChunkByLinesOptions): Chunk[] {
  const normalized = normalizeNewlines(content);
  if (normalized.trim().length === 0) {
    return [];
  }

  const maxLines = Math.max(1, Math.floor(opts?.maxLines ?? DEFAULT_MAX_LINES));
  // Overlap cannot consume the whole window, otherwise the cursor would not advance.
  const requestedOverlap = Math.floor(opts?.overlap ?? DEFAULT_OVERLAP);
  const overlap = Math.min(Math.max(0, requestedOverlap), maxLines - 1);
  const step = maxLines - overlap;

  const lines = normalized.split('\n');
  const total = lines.length;

  const chunks: Chunk[] = [];
  let chunkIndex = 0;
  for (let start = 0; start < total; start += step) {
    const end = Math.min(start + maxLines, total);
    const windowLines = lines.slice(start, end);
    const chunkContent = windowLines.join('\n');
    chunks.push({
      chunkIndex,
      content: chunkContent,
      startLine: start + 1,
      endLine: end,
      tokenEstimate: estimateTokens(chunkContent),
    });
    chunkIndex += 1;
  }

  return chunks;
}
