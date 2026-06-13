import { describe, expect, it } from 'vitest';

import { chunkByLines, estimateTokens, normalizeNewlines } from '../../../src/core/chunker.js';

describe('normalizeNewlines', () => {
  it('converts CRLF and lone CR to LF', () => {
    expect(normalizeNewlines('a\r\nb\rc\nd')).toBe('a\nb\nc\nd');
  });
});

describe('estimateTokens', () => {
  it('rounds up at ~4 chars per token', () => {
    expect(estimateTokens('')).toBe(0);
    expect(estimateTokens('abcd')).toBe(1);
    expect(estimateTokens('abcde')).toBe(2);
  });
});

describe('chunkByLines', () => {
  it('returns [] for empty or whitespace-only input', () => {
    expect(chunkByLines('')).toEqual([]);
    expect(chunkByLines('   \n  \n\t')).toEqual([]);
  });

  it('emits a single chunk with 1-based inclusive line numbers when it fits', () => {
    const content = 'line1\nline2\nline3';
    const chunks = chunkByLines(content, { maxLines: 200 });
    expect(chunks).toHaveLength(1);
    const chunk = chunks[0];
    expect(chunk).toBeDefined();
    if (chunk === undefined) return; // narrow for noUncheckedIndexedAccess
    expect(chunk.chunkIndex).toBe(0);
    expect(chunk.startLine).toBe(1); // 1-based
    expect(chunk.endLine).toBe(3); // inclusive
    expect(chunk.content).toBe(content);
  });

  it('splits large content into multiple contiguous chunks', () => {
    const lines = Array.from({ length: 10 }, (_, i) => `l${i + 1}`);
    const chunks = chunkByLines(lines.join('\n'), { maxLines: 4 });

    // 10 lines / 4 per window => windows [1-4], [5-8], [9-10].
    expect(chunks).toHaveLength(3);
    expect(chunks.map((c) => [c.startLine, c.endLine])).toEqual([
      [1, 4],
      [5, 8],
      [9, 10],
    ]);
    expect(chunks.map((c) => c.chunkIndex)).toEqual([0, 1, 2]);

    const first = chunks[0];
    const last = chunks[2];
    expect(first?.content).toBe('l1\nl2\nl3\nl4');
    expect(last?.content).toBe('l9\nl10');
  });

  it('normalizes CRLF before splitting so line numbers stay accurate', () => {
    const chunks = chunkByLines('a\r\nb\r\nc', { maxLines: 200 });
    expect(chunks).toHaveLength(1);
    const chunk = chunks[0];
    expect(chunk?.content).toBe('a\nb\nc');
    expect(chunk?.endLine).toBe(3);
    // Content must carry no CR after normalization.
    expect(chunk?.content.includes('\r')).toBe(false);
  });

  it('supports overlap between consecutive windows', () => {
    const lines = Array.from({ length: 6 }, (_, i) => `l${i + 1}`);
    const chunks = chunkByLines(lines.join('\n'), { maxLines: 3, overlap: 1 });
    // step = 3 - 1 = 2 => windows start at 1,3,5 => [1-3],[3-5],[5-6].
    expect(chunks.map((c) => [c.startLine, c.endLine])).toEqual([
      [1, 3],
      [3, 5],
      [5, 6],
    ]);
  });

  it('coerces an overlap >= maxLines so the cursor always advances', () => {
    const lines = Array.from({ length: 5 }, (_, i) => `l${i + 1}`);
    // overlap is clamped to maxLines-1; this must terminate, not loop forever.
    const chunks = chunkByLines(lines.join('\n'), { maxLines: 2, overlap: 99 });
    expect(chunks.length).toBeGreaterThan(0);
    const lastChunk = chunks[chunks.length - 1];
    expect(lastChunk?.endLine).toBe(5);
  });
});
