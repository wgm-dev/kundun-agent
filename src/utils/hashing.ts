// Deterministic content hashing helpers used across indexing and chunking.
// All functions return lowercase hexadecimal SHA-256 digests.

import { createHash } from 'node:crypto';

// Single algorithm used everywhere in MVP1.
export const HASH_ALGO = 'sha256';

// Hash a UTF-8 string and return a lowercase hex digest.
export function hashString(s: string): string {
  return createHash(HASH_ALGO).update(s, 'utf8').digest('hex');
}

// Hash a raw buffer (e.g. file bytes) and return a lowercase hex digest.
export function hashBuffer(b: Buffer): string {
  return createHash(HASH_ALGO).update(b).digest('hex');
}

// Hash a single chunk's content. Alias of hashString for call-site clarity.
export function hashChunk(content: string): string {
  return hashString(content);
}
