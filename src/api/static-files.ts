// Dependency-free static file server for the local API (README §MVP3 dashboard).
// Serves the bundled "Kundun Control Center" UI shell as PUBLIC static files,
// scoped (sandboxed) to a single root directory. The UI shell is not secret;
// the DATA routes it calls still require the Bearer token. This module is mounted
// in local-server.ts AFTER route matching fails and only for GET/HEAD, so it runs
// strictly after enforceLoopbackHost has already passed.
//
// SECURITY (sandbox): the decoded request path is rejected if it contains a NUL
// byte or a '..' segment; the candidate is resolved against rootDir and the
// result MUST remain inside rootDir (segment-boundary check, not a naive
// startsWith). Symlinks are NOT followed — a symlinked entry that escapes the
// root is treated as a miss. Any escape, fs error, missing file, or directory
// hit returns false so the caller answers 404 exactly as before. There is no
// directory listing, and only GET/HEAD are handled.

import { createReadStream, lstatSync } from 'node:fs';
import type { Stats } from 'node:fs';
import type { ServerResponse } from 'node:http';
import path from 'node:path';

import { isInsideRoot } from '../utils/path-safety.js';
import type { Logger } from '../utils/logger.js';

/** The static server: tries to serve a request, reporting whether it handled it. */
export interface StaticServer {
  /**
   * Attempt to serve `urlPath` (a pathname, query already stripped by the caller)
   * for the given HTTP method. Writes the response and returns true when handled;
   * returns false (writing nothing) when the request is out of scope (non-GET/HEAD,
   * escape attempt, missing file, or a directory) so the caller can 404.
   */
  tryServe(method: string, urlPath: string, res: ServerResponse): boolean;
}

/** Options for {@link createStaticServer}. */
export interface CreateStaticServerOptions {
  /** Absolute directory the server is sandboxed to (e.g. the packaged dashboard). */
  rootDir: string;
  /** Optional logger; a child namespace 'static-files' is used when present. */
  logger?: Logger;
}

/** The file served for '/' and '' (no directory listing is ever produced). */
const INDEX_FILE = 'index.html';

/** Map a lowercased file extension to a Content-Type (charset added for text). */
const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

/** Extensions whose Content-Type should carry '; charset=utf-8'. */
const TEXT_EXTENSIONS = new Set(['.html', '.js', '.mjs', '.css', '.json', '.svg']);

/** Resolve the Content-Type header value for a file path (by extension). */
function contentTypeFor(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  const base = CONTENT_TYPES[ext] ?? 'application/octet-stream';
  return TEXT_EXTENSIONS.has(ext) ? `${base}; charset=utf-8` : base;
}

/**
 * Decode a request pathname, returning undefined on a malformed sequence. A NUL
 * byte or any '..' segment in the decoded path is rejected (returns undefined).
 * The leading '/' is stripped so the result is a relative, root-anchored path.
 */
function decodeUrlPath(urlPath: string): string | undefined {
  let decoded: string;
  try {
    decoded = decodeURIComponent(urlPath);
  } catch {
    return undefined;
  }
  if (decoded.includes('\0')) {
    return undefined;
  }
  // Normalize both separators so a '..' segment cannot hide behind a backslash.
  const segments = decoded.split(/[\\/]+/).filter((s) => s.length > 0);
  if (segments.some((s) => s === '..')) {
    return undefined;
  }
  return segments.join('/');
}

/**
 * Create a static file server sandboxed to `opts.rootDir`. Construction does no
 * I/O; each {@link StaticServer.tryServe} call validates and resolves the request
 * path under the root before touching the filesystem.
 */
export function createStaticServer(opts: CreateStaticServerOptions): StaticServer {
  const rootDir = path.resolve(opts.rootDir);
  const log = opts.logger?.child('static-files');

  function tryServe(method: string, urlPath: string, res: ServerResponse): boolean {
    if (method !== 'GET' && method !== 'HEAD') {
      return false;
    }

    const relative = decodeUrlPath(urlPath);
    if (relative === undefined) {
      // Malformed encoding, NUL byte, or a '..' segment — never read; let it 404.
      return false;
    }

    // '/' and '' map to the index file; otherwise serve the requested relative path.
    const requested = relative.length === 0 ? INDEX_FILE : relative;
    const candidate = path.resolve(rootDir, requested);

    // Sandbox: the resolved candidate MUST stay inside the root (segment-safe).
    if (!isInsideRoot(rootDir, candidate)) {
      log?.warn('blocked path escape', { urlPath });
      return false;
    }

    let stat: Stats;
    try {
      // lstatSync does NOT follow symlinks: we stat the link entry itself so a
      // symlinked file is rejected below rather than read through. (The dashboard
      // dir is trusted static content; we still refuse to follow links so a
      // planted symlink cannot escape the sandbox.)
      stat = lstatSync(candidate);
    } catch {
      // Missing file or any fs error: treat as a miss (caller answers 404).
      return false;
    }

    if (!stat.isFile()) {
      // Directory (no listing), symlink, or special file: not served.
      return false;
    }

    const headers: Record<string, string> = {
      'Content-Type': contentTypeFor(candidate),
      'Cache-Control': 'no-cache',
    };

    if (method === 'HEAD') {
      res.writeHead(200, headers);
      res.end();
      return true;
    }

    res.writeHead(200, headers);
    const stream = createReadStream(candidate);
    stream.on('error', () => {
      // A read error after headers are sent: terminate the response. Status is
      // already 200; we cannot change it, so just end the stream cleanly.
      log?.warn('read error after headers', { urlPath });
      res.end();
    });
    // ServerResponse is a Writable; pipe the file stream straight into it.
    stream.pipe(res);
    return true;
  }

  return { tryServe };
}
