// The forge's HTTP server: one dispatcher for the four surfaces the suite
// drives — git smart HTTP at /{owner}/{repo}.git, REST v3 under /api/v3,
// GraphQL at /api/graphql and MCP at /mcp — plus the env's /healthz probe.
// Every surface but /healthz requires the trial's bearer token; a missing
// or wrong token is a 401 JSON body, and anything unknown is a JSON 404.
//
// app.ts is deliberately separate from main.ts: this is the server, the
// file that grows; main.ts is the entry <-> env lifecycle and stays as it is.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { authorized, makeCtx, readBody, sendError, sendJson, type Ctx } from './lib/http.ts';
import { handleRest } from './lib/rest.ts';
import { handleGit } from './lib/git-http.ts';
import { handleGraphql } from './lib/graphql.ts';
import { handleMcp } from './lib/mcp.ts';

/** Route one request to its surface. */
async function dispatch(ctx: Ctx): Promise<void> {
  const seg = ctx.segments;

  // The env's boot check: no auth, always the same answer.
  if (ctx.method === 'GET' && ctx.path === '/healthz') {
    sendJson(ctx, 200, { ok: true });
    return;
  }

  if (!authorized(ctx)) {
    sendError(ctx, 401, 'Requires authentication');
    return;
  }

  if (seg[0] === 'api' && seg[1] === 'v3') {
    handleRest(ctx);
    return;
  }
  if (seg[0] === 'api' && seg[1] === 'graphql') {
    await handleGraphql(ctx);
    return;
  }
  if (seg[0] === 'mcp') {
    await handleMcp(ctx);
    return;
  }
  // Git smart HTTP lives at /{owner}/{repo}.git/...
  if (seg.length >= 2 && (seg[1] as string).endsWith('.git')) {
    handleGit(ctx);
    return;
  }
  sendError(ctx, 404, 'Not Found');
}

/** Build the server. It binds nothing until the caller listens. */
export function createApp(): Server {
  return createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      try {
        const body = await readBody(req);
        const ctx = makeCtx(req, res, body);
        await dispatch(ctx);
      } catch {
        if (!res.headersSent) {
          res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' });
          res.end('{"message":"Internal Server Error"}\n');
        } else if (!res.writableEnded) {
          res.end();
        }
      }
    })();
  });
}
