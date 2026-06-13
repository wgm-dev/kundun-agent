// Unit tests for the binary-detection heuristics: NUL/control-char sniffing and
// the extension allowlist. Pure functions, no I/O.

import { describe, expect, it } from 'vitest';

import {
  isBinaryBuffer,
  isLikelyBinaryByExtension,
  BINARY_EXTENSIONS,
} from '../../../src/utils/binary-detection.js';

describe('isBinaryBuffer', () => {
  it('treats a buffer containing a NUL byte as binary', () => {
    const buf = Buffer.from([0x68, 0x69, 0x00, 0x21]); // "hi\0!"
    expect(isBinaryBuffer(buf)).toBe(true);
  });

  it('treats plain ASCII text as not binary', () => {
    expect(isBinaryBuffer(Buffer.from('const x = 1;\nexport default x;\n', 'utf8'))).toBe(false);
  });

  it('treats an empty buffer as not binary', () => {
    expect(isBinaryBuffer(Buffer.alloc(0))).toBe(false);
  });

  it('allows tab, newline and carriage-return without flagging binary', () => {
    expect(isBinaryBuffer(Buffer.from('line1\r\n\tindented\n', 'utf8'))).toBe(false);
  });

  it('flags a buffer dominated by C0 control characters', () => {
    // 16 bytes of 0x01 (a control char, no NUL) -> ratio 1.0 > threshold.
    const buf = Buffer.alloc(16, 0x01);
    expect(isBinaryBuffer(buf)).toBe(true);
  });
});

describe('isLikelyBinaryByExtension', () => {
  it('recognizes known binary extensions, with or without a leading dot', () => {
    expect(isLikelyBinaryByExtension('png')).toBe(true);
    expect(isLikelyBinaryByExtension('.png')).toBe(true);
  });

  it('is case-insensitive', () => {
    expect(isLikelyBinaryByExtension('PNG')).toBe(true);
    expect(isLikelyBinaryByExtension('.JPG')).toBe(true);
  });

  it('returns false for source-code extensions', () => {
    expect(isLikelyBinaryByExtension('ts')).toBe(false);
    expect(isLikelyBinaryByExtension('.php')).toBe(false);
    expect(isLikelyBinaryByExtension('go')).toBe(false);
  });

  it('returns false for an empty extension', () => {
    expect(isLikelyBinaryByExtension('')).toBe(false);
    expect(isLikelyBinaryByExtension('.')).toBe(false);
  });

  it('recognizes MU game blob extensions present in the allowlist', () => {
    expect(isLikelyBinaryByExtension('bmd')).toBe(true);
    expect(isLikelyBinaryByExtension('ozt')).toBe(true);
  });
});

describe('BINARY_EXTENSIONS', () => {
  it('contains common binary types and is keyed without leading dots', () => {
    expect(BINARY_EXTENSIONS.has('exe')).toBe(true);
    expect(BINARY_EXTENSIONS.has('zip')).toBe(true);
    expect(BINARY_EXTENSIONS.has('.exe')).toBe(false);
  });
});
