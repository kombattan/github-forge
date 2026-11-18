// Small HTTP plumbing shared by every surface: body reading, JSON replies
// with the headers the suite requires on all of them, and the request
// context object handlers receive.

import type { IncomingMessage, ServerResponse } from 'node:http';
import { store } from './store.ts';

export const JSON_TYPE = 'application/json; charset=utf-8';

/** The parsed request one handler sees. */
export interface Ctx {
  req: IncomingMessage;
  res: ServerResponse;
  method: string;
  /** URL path segments, percent-decoded, no leading empty entry. */
  segments: string[];
  /** The full decoded path (for routes whose tail is a file path). */
  path: string;
  query: URLSearchParams;
  /** Raw request body bytes. */
  body: Buffer;
  /** Parsed JSON body when it parsed, else undefined. */
  json: Record<string, unknown> | undefined;
  /** The parsed JSON body exactly as it arrived (arrays included). */
  jsonRaw: unknown;
  /** True when a body was present but was not valid JSON. */
  jsonError: boolean;
}

/** The shared empty body for requests that carry none. */
const EMPTY_BODY = Buffer.alloc(0);

/** Read a request body to the end. */
export function readBody(req: IncomingMessage): Promise<Buffer> {
  // A request with no Content-Length and no Transfer-Encoding has no body
  // by definition: answer at once instead of waiting a stream turn for an
  // 'end' that carries nothing. Most GETs (every advertisement, every REST
  // read) take this path.
  const length = req.headers['content-length'];
  if ((length === undefined || length === '0') && req.headers['transfer-encoding'] === undefined) {
    return Promise.resolve(EMPTY_BODY);
  }
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      // The common case is one chunk (or none): hand it over without the
      // copy Buffer.concat would make of it.
      if (chunks.length === 1) resolve(chunks[0] as Buffer);
      else resolve(Buffer.concat(chunks));
    });
    req.on('error', reject);
  });
}

/** Build the handler context for one request. */
export function makeCtx(req: IncomingMessage, res: ServerResponse, body: Buffer): Ctx {
  const url = new URL(req.url ?? '/', 'http://entry');
  const path = url.pathname;
  const segments: string[] = [];
  for (const part of path.split('/')) {
    if (part === '') continue;
    // Almost no segment carries an escape; decodeURIComponent's try/catch
    // is only paid for the ones that do.
    if (!part.includes('%')) {
      segments.push(part);
      continue;
    }
    try {
      segments.push(decodeURIComponent(part));
    } catch {
      segments.push(part);
    }
  }
  let json: Record<string, unknown> | undefined;
  let jsonRaw: unknown;
  let jsonError = false;
  // Git smart-HTTP bodies are pkt-lines and pack bytes, never JSON, and no
  // git handler reads the parsed body: skip the utf8 decode and the doomed
  // JSON.parse of a binary pack on every push and fetch.
  const isGit = segments.length >= 2 && (segments[1] as string).endsWith('.git');
  if (body.length > 0 && !isGit) {
    try {
      const parsed: unknown = JSON.parse(body.toString('utf8'));
      jsonRaw = parsed;
      if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) json = parsed as Record<string, unknown>;
      else json = { value: parsed } as Record<string, unknown>;
    } catch {
      jsonError = true;
    }
  }
  return { req, res, method: req.method ?? 'GET', segments, path, query: url.searchParams, body, json, jsonRaw, jsonError };
}

/** Answer with a JSON body and the headers every reply must carry. */
export function sendJson(ctx: Ctx, status: number, body: unknown, headers: Record<string, string> = {}): void {
  // Encode once: the buffer's length is the content length, and handing the
  // socket a buffer skips the second utf8 pass res.end(string) would make.
  const data = Buffer.from(`${JSON.stringify(body)}\n`, 'utf8');
  ctx.res.writeHead(status, {
    'content-type': JSON_TYPE,
    'content-length': data.length,
    'x-github-request-id': store.nextRequestId(),
    ...headers,
  });
  ctx.res.end(data);
}

/** Answer with a pre-encoded JSON body (a memoized serialization). */
export function sendJsonBuffer(ctx: Ctx, status: number, data: Buffer, headers: Record<string, string> = {}): void {
  ctx.res.writeHead(status, {
    'content-type': JSON_TYPE,
    'content-length': data.length,
    'x-github-request-id': store.nextRequestId(),
    ...headers,
  });
  ctx.res.end(data);
}

/** Answer with raw bytes (git protocol replies, packfiles). */
export function sendBytes(ctx: Ctx, status: number, data: Buffer, contentType: string, headers: Record<string, string> = {}): void {
  ctx.res.writeHead(status, {
    'content-type': contentType,
    'content-length': data.length,
    'x-github-request-id': store.nextRequestId(),
    ...headers,
  });
  ctx.res.end(data);
}

/** The GitHub-shaped error body: a JSON object with a non-empty message. */
export function sendError(ctx: Ctx, status: number, message: string): void {
  sendJson(ctx, status, { message });
}

/** The bearer token, read from the environment once (it never changes under a running trial). */
let tokenCache: string | null | undefined;

/** The bearer token the trial issued, or null when none is configured. */
export function expectedToken(): string | null {
  if (tokenCache === undefined) {
    const token = process.env.MAKEFUN_SHOP_TOKEN;
    tokenCache = token === undefined || token === '' ? null : token;
  }
  return tokenCache;
}

/**
 * True when the request carries the trial's bearer token. When no token is
 * configured (a local smoke run), every request passes.
 */
export function authorized(ctx: Ctx): boolean {
  const token = expectedToken();
  if (token === null) return true;
  const header = ctx.req.headers.authorization;
  return header === `Bearer ${token}`;
}
