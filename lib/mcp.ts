// The MCP endpoint: JSON-RPC 2.0 over Streamable HTTP at /mcp. It speaks
// the 2026-07-28 revision through server/discover and the handshake
// revisions through initialize, and its six tools act on the same store
// as REST and GraphQL, so an object made here reads back identically
// everywhere. The tool list is a fixed constant: two tools/list calls
// must answer byte for byte the same list.

import { store, VIEWER, type IssueRec, type PullRec, type RepoRec } from './store.ts';
import { issueJson, performSquashMerge, pullJson, repoJson } from './rest.ts';
import { sendJson, type Ctx } from './http.ts';

const SUPPORTED_VERSIONS = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26'];
const SERVER_INFO = { name: 'forge-mcp', version: '1.0.0' };

interface ToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

function tool(name: string, description: string, properties: Record<string, unknown>, required: string[]): ToolDef {
  return { name, description, inputSchema: { type: 'object', properties, required } };
}

const OWNER_REPO_PROPS = {
  owner: { type: 'string', description: 'The repository owner login.' },
  repo: { type: 'string', description: 'The repository name.' },
  full_name: { type: 'string', description: 'The full repository name as owner/repo.' },
};

/** The fixed tool list: built once, served identically forever. */
const TOOLS: ToolDef[] = [
  tool('create_repo', 'Create a new repository for the authenticated user.', {
    name: { type: 'string', description: 'The repository name.' },
    description: { type: 'string', description: 'A short description of the repository.' },
    private: { type: 'boolean', description: 'Whether the repository is private.' },
  }, ['name']),
  tool('get_repo', 'Get a repository by owner and name.', { ...OWNER_REPO_PROPS }, ['owner', 'repo']),
  tool('create_issue', 'Create an issue in a repository.', {
    ...OWNER_REPO_PROPS,
    title: { type: 'string', description: 'The issue title.' },
    body: { type: 'string', description: 'The issue body.' },
    labels: { type: 'array', items: { type: 'string' }, description: 'Label names to apply.' },
  }, ['owner', 'repo', 'title']),
  tool('list_issues', 'List issues in a repository, optionally filtered by state.', {
    ...OWNER_REPO_PROPS,
    state: { type: 'string', description: 'Filter by state: open, closed, or all.' },
  }, ['owner', 'repo']),
  tool('create_pull_request', 'Create a pull request from a head branch onto a base branch.', {
    ...OWNER_REPO_PROPS,
    title: { type: 'string', description: 'The pull request title.' },
    body: { type: 'string', description: 'The pull request body.' },
    head: { type: 'string', description: 'The head branch name.' },
    base: { type: 'string', description: 'The base branch name.' },
  }, ['owner', 'repo', 'title', 'head', 'base']),
  tool('merge_pull_request', 'Merge a pull request by number (squash).', {
    ...OWNER_REPO_PROPS,
    pull_number: { type: 'number', description: 'The pull request number.' },
  }, ['owner', 'repo', 'pull_number']),
];

/** A JSON-RPC error object body. */
function rpcError(id: unknown, code: number, message: string): Record<string, unknown> {
  return { jsonrpc: '2.0', id: id ?? null, error: { code, message } };
}

/** A JSON-RPC result body. */
function rpcResult(id: unknown, result: unknown): Record<string, unknown> {
  return { jsonrpc: '2.0', id: id ?? null, result };
}

/** A tools/call success result: the object as a JSON text content block. */
function toolOk(id: unknown, payload: unknown): Record<string, unknown> {
  return rpcResult(id, { content: [{ type: 'text', text: JSON.stringify(payload) }], isError: false });
}

/** A tools/call failure result (isError), for bad arguments or missing objects. */
function toolError(id: unknown, message: string): Record<string, unknown> {
  return rpcResult(id, { content: [{ type: 'text', text: message }], isError: true });
}

/** Resolve owner/repo arguments, honoring a full_name stand-in. */
function repoArgs(args: Record<string, unknown>): { owner: string; repo: string } | null {
  let owner = typeof args.owner === 'string' ? args.owner : '';
  let repo = typeof args.repo === 'string' ? args.repo : '';
  if ((owner === '' || repo === '') && typeof args.full_name === 'string' && args.full_name.includes('/')) {
    const [o, r] = args.full_name.split('/', 2);
    if (owner === '') owner = o as string;
    if (repo === '') repo = r as string;
  }
  if (owner === '' || repo === '') return null;
  return { owner, repo };
}

/** Run one tool by its bare name (any server prefix already stripped). */
function callTool(id: unknown, name: string, args: Record<string, unknown>): Record<string, unknown> {
  switch (name) {
    case 'create_repo': {
      const repoName = typeof args.name === 'string' ? args.name : '';
      if (repoName === '') return toolError(id, 'name is required');
      const repo = store.createRepo(repoName, {
        description: typeof args.description === 'string' ? args.description : '',
        isPrivate: typeof args.private === 'boolean' ? args.private : false,
      });
      if (repo === null) return toolError(id, 'name already exists on this account');
      return toolOk(id, repoJson(repo));
    }
    case 'get_repo': {
      const target = repoArgs(args);
      if (target === null) return toolError(id, 'owner and repo are required');
      const repo = store.getRepo(target.owner, target.repo);
      if (repo === null) return toolError(id, 'repository not found');
      return toolOk(id, repoJson(repo));
    }
    case 'create_issue': {
      const target = repoArgs(args);
      if (target === null) return toolError(id, 'owner and repo are required');
      const repo = store.getRepo(target.owner, target.repo);
      if (repo === null) return toolError(id, 'repository not found');
      const title = typeof args.title === 'string' ? args.title : '';
      if (title === '') return toolError(id, 'title is required');
      const labels = Array.isArray(args.labels) ? args.labels.map((label) => String(label)) : [];
      for (const label of labels) {
        if (!repo.labels.has(label)) return toolError(id, `label "${label}" does not exist`);
      }
      const now = store.nowIso();
      const issue: IssueRec = {
        id: store.nextIssueId(),
        number: repo.nextNumber++,
        title,
        body: typeof args.body === 'string' ? args.body : null,
        state: 'open',
        labels,
        comments: [],
        user: VIEWER.login,
        createdAt: now,
        updatedAt: now,
      };
      repo.issues.set(issue.number, issue);
      return toolOk(id, issueJson(repo, issue));
    }
    case 'list_issues': {
      const target = repoArgs(args);
      if (target === null) return toolError(id, 'owner and repo are required');
      const repo = store.getRepo(target.owner, target.repo);
      if (repo === null) return toolError(id, 'repository not found');
      const state = typeof args.state === 'string' ? args.state : 'open';
      const list = [...repo.issues.values()]
        .filter((issue) => state === 'all' || issue.state === state)
        .sort((a, b) => b.number - a.number);
      return toolOk(id, list.map((issue) => issueJson(repo, issue)));
    }
    case 'create_pull_request': {
      const target = repoArgs(args);
      if (target === null) return toolError(id, 'owner and repo are required');
      const repo = store.getRepo(target.owner, target.repo);
      if (repo === null) return toolError(id, 'repository not found');
      const title = typeof args.title === 'string' ? args.title : '';
      const head = typeof args.head === 'string' ? args.head : '';
      const base = typeof args.base === 'string' ? args.base : '';
      const headSha = store.branchTip(repo, head);
      const baseSha = store.branchTip(repo, base);
      if (headSha === null || baseSha === null) return toolError(id, 'head or base branch does not exist');
      const now = store.nowIso();
      const pull: PullRec = {
        id: store.nextIssueId(),
        number: repo.nextNumber++,
        title,
        body: typeof args.body === 'string' ? args.body : null,
        state: 'open',
        headRef: head,
        baseRef: base,
        headSha,
        baseSha,
        merged: false,
        mergeCommitSha: null,
        comments: [],
        user: VIEWER.login,
        createdAt: now,
        updatedAt: now,
      };
      repo.pulls.set(pull.number, pull);
      return toolOk(id, pullJson(repo, pull));
    }
    case 'merge_pull_request': {
      const target = repoArgs(args);
      if (target === null) return toolError(id, 'owner and repo are required');
      const repo = store.getRepo(target.owner, target.repo);
      if (repo === null) return toolError(id, 'repository not found');
      const number = typeof args.pull_number === 'number' ? args.pull_number : typeof args.pullNumber === 'number' ? args.pullNumber : Number(args.pull_number);
      const pull = Number.isInteger(number) ? repo.pulls.get(number) : undefined;
      if (pull === undefined) return toolError(id, 'pull request not found');
      const sha = performSquashMerge(repo, pull);
      if (sha === null) return toolError(id, 'Pull Request is not mergeable');
      return toolOk(id, { sha, merged: true, message: 'Pull Request successfully merged', pull_request: pullJson(repo, pull) });
    }
    default:
      return rpcError(id, -32601, `Method not found: ${name}`);
  }
}

/** The bare tool name: a server prefix ("github__create_issue") matches by suffix. */
function bareToolName(name: string): string {
  const lower = name.toLowerCase();
  for (const def of TOOLS) {
    if (lower === def.name || lower.endsWith(`__${def.name}`) || lower.endsWith(`/${def.name}`)) return def.name;
  }
  return name;
}

/** Handle one JSON-RPC request object; null means it was a notification. */
function handleRpc(request: Record<string, unknown>): Record<string, unknown> | null {
  const id = request.id;
  const method = typeof request.method === 'string' ? request.method : '';
  const params = (request.params !== null && typeof request.params === 'object' ? request.params : {}) as Record<string, unknown>;
  const isNotification = id === undefined;

  switch (method) {
    case 'server/discover':
      return rpcResult(id, {
        supportedVersions: SUPPORTED_VERSIONS,
        capabilities: { tools: {} },
        serverInfo: SERVER_INFO,
      });
    case 'initialize': {
      const asked = typeof params.protocolVersion === 'string' ? params.protocolVersion : '';
      const version = SUPPORTED_VERSIONS.includes(asked) ? asked : '2025-11-25';
      return rpcResult(id, {
        protocolVersion: version,
        capabilities: { tools: { listChanged: false } },
        serverInfo: SERVER_INFO,
      });
    }
    case 'ping':
      return rpcResult(id, {});
    case 'tools/list':
      return rpcResult(id, { tools: TOOLS });
    case 'tools/call': {
      const name = typeof params.name === 'string' ? params.name : '';
      const args = (params.arguments !== null && typeof params.arguments === 'object' ? params.arguments : {}) as Record<string, unknown>;
      if (name === '') return rpcError(id, -32602, 'Invalid params: a tool name is required');
      const bare = bareToolName(name);
      if (!TOOLS.some((def) => def.name === bare)) return rpcError(id, -32601, `Method not found: ${name}`);
      // A missing required argument is a tool-level error, never a 500.
      const def = TOOLS.find((candidate) => candidate.name === bare) as ToolDef;
      const required = (def.inputSchema.required as string[] | undefined) ?? [];
      const effectiveArgs = { ...args };
      if (typeof args.full_name === 'string' && args.full_name.includes('/')) {
        const [o, r] = args.full_name.split('/', 2);
        if (effectiveArgs.owner === undefined) effectiveArgs.owner = o;
        if (effectiveArgs.repo === undefined) effectiveArgs.repo = r;
      }
      for (const key of required) {
        if (effectiveArgs[key] === undefined || effectiveArgs[key] === '') {
          return toolError(id, `${key} is required`);
        }
      }
      return callTool(id, bare, effectiveArgs);
    }
    default:
      if (isNotification || method.startsWith('notifications/')) return null;
      return rpcError(id, -32601, `Method not found: ${method}`);
  }
}

/** Route one POST /mcp request (single call or a batch array). */
export async function handleMcp(ctx: Ctx): Promise<void> {
  if (ctx.method !== 'POST') {
    sendJson(ctx, 405, rpcError(null, -32601, 'Method not allowed'));
    return;
  }
  if (ctx.jsonError) {
    // A body that is not JSON: HTTP 400 with the JSON-RPC parse error.
    sendJson(ctx, 400, rpcError(null, -32700, 'Parse error'));
    return;
  }
  const raw = ctx.jsonRaw;
  if (Array.isArray(raw)) {
    const responses: Record<string, unknown>[] = [];
    for (const entry of raw) {
      if (entry !== null && typeof entry === 'object') {
        const response = handleRpc(entry as Record<string, unknown>);
        if (response !== null) responses.push(response);
      }
    }
    sendJson(ctx, 200, responses);
    return;
  }
  const request = (raw !== null && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const response = handleRpc(request);
  if (response === null) {
    // A notification: accepted, no body.
    ctx.res.writeHead(202, { 'x-github-request-id': store.nextRequestId() });
    ctx.res.end();
    return;
  }
  const headers: Record<string, string> = {};
  if (request.method === 'initialize') headers['mcp-session-id'] = 'forge-session';
  sendJson(ctx, 200, response, headers);
}
