// GraphQL v4 surface — placeholder while the executor lands.

import { sendError, type Ctx } from './http.ts';

/** Route one POST /api/graphql request. */
export async function handleGraphql(ctx: Ctx): Promise<void> {
  sendError(ctx, 404, 'Not Found');
}
