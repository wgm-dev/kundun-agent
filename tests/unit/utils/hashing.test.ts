// Unit tests for the deterministic content-hashing helpers. All digests are
// lowercase hex SHA-256.

import { describe, expect, it } from 'vitest';

import { hashString, hashBuffer, hashChunk, HASH_ALGO } from '../../../src/utils/hashing.js';

const HEX_64 = /^[0-9a-f]{64}$/;

describe('hashString', () => {
  it('is deterministic for the same input', () => {
    expect(hashString('hello world')).toBe(hashString('hello world'));
  });

  it('returns a 64-char lowercase hex digest', () => {
    expect(hashString('hello world')).toMatch(HEX_64);
  });

  it('produces different digests for different inputs', () => {
    expect(hashString('a')).not.toBe(hashString('b'));
  });

  it('matches the known SHA-256 of an empty string', () => {
    expect(hashString('')).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
  });
});

describe('hashBuffer', () => {
  it('is deterministic and hex-encoded', () => {
    const buf = Buffer.from('some bytes');
    expect(hashBuffer(buf)).toBe(hashBuffer(Buffer.from('some bytes')));
    expect(hashBuffer(buf)).toMatch(HEX_64);
  });

  it('agrees with hashString for equivalent UTF-8 content', () => {
    expect(hashBuffer(Buffer.from('héllo', 'utf8'))).toBe(hashString('héllo'));
  });
});

describe('hashChunk', () => {
  it('is an alias of hashString', () => {
    expect(hashChunk('chunk content')).toBe(hashString('chunk content'));
  });
});

describe('HASH_ALGO', () => {
  it('is sha256', () => {
    expect(HASH_ALGO).toBe('sha256');
  });
});
