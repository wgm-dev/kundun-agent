// Authentication and loopback enforcement for the local HTTP/WS API.
//
// Security model (locked):
// - A 32-byte random token is generated on first use and persisted at
//   {runtimeDir}/token with 0600 permissions. It is cached in memory and is
//   NEVER logged.
// - Presented tokens are compared with a length check followed by
//   crypto.timingSafeEqual on raw Buffers. Any malformed input yields false.
// - HTTP requests and the WS upgrade must originate from loopback: the Host
//   header host must be a loopback literal/localhost, and any present Origin
//   must also be loopback. These checks run BEFORE auth.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import type { Logger } from '../utils/logger.js';

/** Minimal shape of an incoming HTTP request needed for loopback checks. */
interface RequestLike {
  headers: Record<string, string | string[] | undefined>;
}

/** A token store backed by a file under the runtime directory. */
export interface TokenStore {
  /** Read (or lazily generate) the API token. Never logs the value. */
  getToken(): string;
  /** Constant-time compare of a presented token against the stored one. */
  verify(presented: string | undefined): boolean;
  /** Absolute path to the token file. */
  tokenPath: string;
}

export interface TokenStoreOptions {
  /** Directory that holds the token file (created recursively if missing). */
  runtimeDir: string;
  /** Optional logger; only metadata is ever logged, never the token value. */
  logger?: Logger;
}

/** Hosts accepted as loopback for the Host header (port stripped separately). */
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1']);

/**
 * Create a token store. The token is generated on first getToken() call if the
 * file does not already exist, written with mode 0600, and cached in memory.
 */
export function createTokenStore(opts: TokenStoreOptions): TokenStore {
  const runtimeDir = opts.runtimeDir;
  const logger = opts.logger;
  const tokenPath = path.join(runtimeDir, 'token');

  // In-memory cache; populated on first read/generate. Never logged.
  let cached: string | undefined;

  function getToken(): string {
    if (cached !== undefined) {
      return cached;
    }

    // Try to read an existing token first.
    try {
      const raw = fs.readFileSync(tokenPath, 'utf8');
      const trimmed = stripTrailingNewline(raw);
      if (trimmed.length > 0) {
        cached = trimmed;
        return cached;
      }
    } catch (err) {
      if (!isErrnoException(err) || err.code !== 'ENOENT') {
        throw err;
      }
      // ENOENT falls through to generation below.
    }

    // Generate a fresh token and persist it with restrictive permissions.
    fs.mkdirSync(runtimeDir, { recursive: true });
    const token = crypto.randomBytes(32).toString('base64url');
    fs.writeFileSync(tokenPath, token, { mode: 0o600 });
    // Re-assert permissions: writeFileSync's mode is subject to umask and is
    // ignored when the file already exists.
    fs.chmodSync(tokenPath, 0o600);
    cached = token;
    logger?.info('generated new API token', { tokenPath });
    return cached;
  }

  function verify(presented: string | undefined): boolean {
    if (presented == null) {
      return false;
    }
    try {
      const expected = getToken();
      const a = Buffer.from(presented, 'utf8');
      const b = Buffer.from(expected, 'utf8');
      // timingSafeEqual requires equal lengths; the length check itself is not
      // constant-time, which is acceptable since token length is not secret.
      if (a.length !== b.length) {
        return false;
      }
      return crypto.timingSafeEqual(a, b);
    } catch {
      // Any failure (e.g. token file unreadable) is treated as a denied auth.
      return false;
    }
  }

  return { getToken, verify, tokenPath };
}

/**
 * Whether a Host header denotes a loopback origin. The host part must be one of
 * 127.0.0.1 / localhost / ::1; an attached port is accepted only when absent or
 * equal to expectedPort. Missing/malformed headers are rejected.
 */
export function isLoopbackHostHeader(
  hostHeader: string | undefined,
  expectedPort: number,
): boolean {
  if (hostHeader == null) {
    return false;
  }
  const host = hostHeader.trim();
  if (host.length === 0) {
    return false;
  }

  const parsed = splitHostPort(host);
  if (parsed === undefined) {
    return false;
  }
  const { hostname, port } = parsed;

  if (!LOOPBACK_HOSTS.has(hostname.toLowerCase())) {
    return false;
  }
  if (port !== undefined && port !== expectedPort) {
    return false;
  }
  return true;
}

/**
 * Enforce that a request is loopback-only: the Host header must be loopback AND
 * any present Origin header must also be loopback (an absent Origin is allowed).
 * Returns true when the request may proceed, false otherwise.
 */
export function enforceLoopbackHost(req: RequestLike, expectedPort: number): boolean {
  const host = headerValue(req.headers['host']);
  if (!isLoopbackHostHeader(host, expectedPort)) {
    return false;
  }

  const origin = headerValue(req.headers['origin']);
  if (origin !== undefined && origin.length > 0) {
    if (!isLoopbackOrigin(origin)) {
      return false;
    }
  }
  return true;
}

/** Extract a bearer token from an Authorization header, if present. */
export function parseBearer(authHeader: string | undefined): string | undefined {
  if (authHeader == null) {
    return undefined;
  }
  const match = /^Bearer[ \t]+(.+)$/i.exec(authHeader.trim());
  if (match === null) {
    return undefined;
  }
  const token = match[1]?.trim();
  return token !== undefined && token.length > 0 ? token : undefined;
}

/** Extract the ?token= query parameter from a request URL (path or absolute). */
export function parseWsToken(url: string | undefined): string | undefined {
  if (url == null || url.length === 0) {
    return undefined;
  }
  // The request URL may be path-only (e.g. "/ws?token=abc"); provide a dummy
  // base so URL parsing succeeds for relative inputs.
  let token: string | null;
  try {
    token = new URL(url, 'http://127.0.0.1').searchParams.get('token');
  } catch {
    return undefined;
  }
  if (token === null) {
    return undefined;
  }
  const trimmed = token.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/** Whether an Origin header (a full URL) points at a loopback host. */
function isLoopbackOrigin(origin: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(origin);
  } catch {
    return false;
  }
  return LOOPBACK_HOSTS.has(parsed.hostname.toLowerCase());
}

/**
 * Split a "host" authority into hostname and optional numeric port. Handles
 * bracketed IPv6 literals ("[::1]" / "[::1]:37373") and bare IPv4/hostnames.
 * Returns undefined for malformed authorities.
 */
function splitHostPort(host: string): { hostname: string; port: number | undefined } | undefined {
  // Bracketed IPv6 form: [::1] optionally followed by :port.
  if (host.startsWith('[')) {
    const close = host.indexOf(']');
    if (close === -1) {
      return undefined;
    }
    const hostname = host.slice(1, close);
    const rest = host.slice(close + 1);
    if (rest.length === 0) {
      return { hostname, port: undefined };
    }
    if (!rest.startsWith(':')) {
      return undefined;
    }
    const port = parsePort(rest.slice(1));
    return port === undefined ? undefined : { hostname, port };
  }

  // Bare IPv6 literal without brackets and without a port (contains ':').
  if (host.indexOf(':') !== host.lastIndexOf(':')) {
    // More than one colon -> treat the whole thing as an IPv6 hostname.
    return { hostname: host, port: undefined };
  }

  const colon = host.indexOf(':');
  if (colon === -1) {
    return { hostname: host, port: undefined };
  }
  const hostname = host.slice(0, colon);
  const port = parsePort(host.slice(colon + 1));
  return port === undefined ? undefined : { hostname, port };
}

/** Parse a strictly-numeric port string into a number, or undefined if invalid. */
function parsePort(raw: string): number | undefined {
  if (!/^\d+$/.test(raw)) {
    return undefined;
  }
  const n = Number.parseInt(raw, 10);
  return Number.isInteger(n) && n >= 0 && n <= 65_535 ? n : undefined;
}

/** Collapse a possibly-array header value to a single string (first element). */
function headerValue(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) {
    return value[0];
  }
  return value;
}

/** Remove a single trailing CR/LF (or CRLF) from a token read from disk. */
function stripTrailingNewline(s: string): string {
  return s.replace(/\r?\n$/, '');
}

/** Narrow an unknown error to a Node errno exception. */
function isErrnoException(err: unknown): err is NodeJS.ErrnoException {
  return err instanceof Error && typeof (err as NodeJS.ErrnoException).code === 'string';
}
