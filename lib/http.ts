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
  /** True when a body was present but was not valid JSON. */
  jsonError: boolean;
}

/** Read a request body to the end. */
export function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/** Build the handler context for one request. */
export function makeCtx(req: IncomingMessage, res: ServerResponse, body: Buffer): Ctx {
  const url = new URL(req.url ?? '/', 'http://entry');
  const path = url.pathname;
  const segments = path
    .split('/')
    .filter((part) => part !== '')
    .map((part) => {
      try {
        return decodeURIComponent(part);
      } catch {
        return part;
      }
    });
  let json: Record<string, unknown> | undefined;
  let jsonError = false;
  if (body.length > 0) {
    try {
      const parsed: unknown = JSON.parse(body.toString('utf8'));
      if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) json = parsed as Record<string, unknown>;
      else json = { value: parsed } as Record<string, unknown>;
    } catch {
      jsonError = true;
    }
  }
  return { req, res, method: req.method ?? 'GET', segments, path, query: url.searchParams, body, json, jsonError };
}

/** Answer with a JSON body and the headers every reply must carry. */
export function sendJson(ctx: Ctx, status: number, body: unknown, headers: Record<string, string> = {}): void {
  const text = `${JSON.stringify(body)}\n`;
  ctx.res.writeHead(status, {
    'content-type': JSON_TYPE,
    'content-length': Buffer.byteLength(text),
    'x-github-request-id': store.nextRequestId(),
    ...headers,
  });
  ctx.res.end(text);
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

/** The bearer token the trial issued, or null when none is configured. */
export function expectedToken(): string | null {
  const token = process.env.MAKEFUN_SHOP_TOKEN;
  return token === undefined || token === '' ? null : token;
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
