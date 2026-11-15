// Git smart HTTP surface — placeholder while the protocol lands; a missing
// repository is a 404 here exactly as the finished surface answers.

import { sendError, type Ctx } from './http.ts';

/** Route one /{owner}/{repo}.git request. */
export function handleGit(ctx: Ctx): void {
  sendError(ctx, 404, 'Not Found');
}
