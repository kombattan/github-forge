// MCP surface — placeholder while the JSON-RPC endpoint lands.

import { sendError, type Ctx } from './http.ts';

/** Route one POST /mcp request. */
export async function handleMcp(ctx: Ctx): Promise<void> {
  sendError(ctx, 404, 'Not Found');
}
