// Test helper: a tiny fetch-based HTTP client for the local API integration tests.
// Uses the Node 20 global `fetch` (available since Node 18) and NEVER throws on a
// non-2xx response — callers assert on the returned `status`. The body is exposed
// both as parsed JSON (best-effort, `undefined` when the body is empty or not
// JSON) and as the raw text so a test can assert on either.
//
// A second, raw `node:http` path is provided for the cases fetch cannot express:
// undici (the fetch impl) treats `Host` as a forbidden header and refuses to let a
// caller override it, so the loopback-host enforcement test forges the Host header
// via node:http instead.

import { request as httpRequest } from 'node:http';

/** Options accepted by {@link httpGet} / {@link httpPost}. */
export interface HttpRequestOptions {
  /** Optional bearer token sent as `Authorization: Bearer <token>`. */
  token?: string;
  /** Optional JSON body (POST only); serialized with JSON.stringify. */
  body?: unknown;
  /** Extra request headers (e.g. a manual `Host`) merged over the defaults. */
  headers?: Record<string, string>;
}

/** The normalized result of an HTTP call. */
export interface HttpResult {
  /** HTTP status code. */
  status: number;
  /** Parsed JSON body, or undefined when the body is empty / not valid JSON. */
  json: unknown;
  /** Raw response body text (possibly empty). */
  text: string;
  /** Response headers as a plain lowercase-keyed object. */
  headers: Record<string, string>;
}

/** Collapse a Headers instance into a plain object (lowercase keys). */
function headersToObject(headers: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  headers.forEach((value, key) => {
    out[key.toLowerCase()] = value;
  });
  return out;
}

/** Build the request init shared by GET and POST, then perform the fetch. */
async function request(
  method: 'GET' | 'POST',
  url: string,
  opts: HttpRequestOptions = {},
): Promise<HttpResult> {
  const headers: Record<string, string> = {};
  if (opts.token !== undefined) {
    headers['authorization'] = `Bearer ${opts.token}`;
  }

  const init: RequestInit = { method };
  if (method === 'POST' && opts.body !== undefined) {
    headers['content-type'] = 'application/json';
    init.body = JSON.stringify(opts.body);
  }
  // Caller-supplied headers win (e.g. a deliberately non-loopback Host).
  if (opts.headers !== undefined) {
    Object.assign(headers, opts.headers);
  }
  init.headers = headers;

  // fetch only rejects on a network/transport error, never on a non-2xx status,
  // so the caller can always assert on result.status.
  const res = await fetch(url, init);
  const text = await res.text();
  let json: unknown;
  if (text.length > 0) {
    try {
      json = JSON.parse(text);
    } catch {
      json = undefined;
    }
  }
  return { status: res.status, json, text, headers: headersToObject(res.headers) };
}

/** Perform a GET request; never throws on a non-2xx status. */
export function httpGet(url: string, opts: HttpRequestOptions = {}): Promise<HttpResult> {
  return request('GET', url, opts);
}

/** Perform a POST request; never throws on a non-2xx status. */
export function httpPost(url: string, opts: HttpRequestOptions = {}): Promise<HttpResult> {
  return request('POST', url, opts);
}

/** Options for {@link rawHttpGet}. */
export interface RawHttpOptions {
  /** Forge the `Host` request header (fetch/undici forbids overriding this). */
  hostHeader?: string;
  /** Optional bearer token. */
  token?: string;
}

/**
 * Issue a GET via node:http so the caller can forge headers fetch refuses to set
 * (notably `Host`). The TCP connection still targets the real host/port parsed
 * from `url`; only the Host *header* is overridden. Never throws on a non-2xx.
 */
export function rawHttpGet(url: string, opts: RawHttpOptions = {}): Promise<HttpResult> {
  const parsed = new URL(url);
  const headers: Record<string, string> = {};
  if (opts.hostHeader !== undefined) {
    headers['Host'] = opts.hostHeader;
  }
  if (opts.token !== undefined) {
    headers['Authorization'] = `Bearer ${opts.token}`;
  }

  return new Promise<HttpResult>((resolve, reject) => {
    const req = httpRequest(
      {
        method: 'GET',
        hostname: parsed.hostname,
        port: parsed.port,
        path: `${parsed.pathname}${parsed.search}`,
        headers,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let json: unknown;
          if (text.length > 0) {
            try {
              json = JSON.parse(text);
            } catch {
              json = undefined;
            }
          }
          const outHeaders: Record<string, string> = {};
          for (const [key, value] of Object.entries(res.headers)) {
            outHeaders[key.toLowerCase()] = Array.isArray(value) ? (value[0] ?? '') : (value ?? '');
          }
          resolve({ status: res.statusCode ?? 0, json, text, headers: outHeaders });
        });
      },
    );
    req.on('error', reject);
    req.end();
  });
}
