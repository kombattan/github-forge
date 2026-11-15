// The REST v3 surface: /api/v3 root and meta, the viewer's repositories,
// branches, commits and contents, labels, issues and comments, and pull
// requests with their files and squash merges. Shapes follow GitHub's API
// as the suite's checks require them; unknown routes are a JSON 404 and a
// malformed JSON body is a 400, never an HTML error page.

import {
  buildTree,
  flattenTree,
  getObject,
  parseCommit,
  parseTree,
  putObject,
  store,
  VIEWER,
  INSTALLED_VERSION,
  type IssueRec,
  type PullRec,
  type RepoRec,
} from './store.ts';
import { sendError, sendJson, type Ctx } from './http.ts';

/** A string field from a JSON body, or null when absent/not a string. */
function str(body: Record<string, unknown>, key: string): string | null {
  const value = body[key];
  return typeof value === 'string' ? value : null;
}

/** A boolean field from a JSON body, or null. */
function bool(body: Record<string, unknown>, key: string): boolean | null {
  const value = body[key];
  return typeof value === 'boolean' ? value : null;
}

/** The viewer's public user object. */
export function userJson(): Record<string, unknown> {
  return {
    login: VIEWER.login,
    id: VIEWER.id,
    node_id: Buffer.from(`04:User${VIEWER.id}`).toString('base64'),
    avatar_url: '',
    html_url: '',
    type: 'User',
    name: VIEWER.name,
    email: VIEWER.email,
  };
}

/** The repository object as REST returns it everywhere. */
export function repoJson(repo: RepoRec): Record<string, unknown> {
  return {
    id: repo.id,
    node_id: Buffer.from(`010:Repository${repo.id}`).toString('base64'),
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: userJson(),
    private: repo.isPrivate,
    html_url: '',
    description: repo.description,
    fork: false,
    url: '',
    git_url: '',
    clone_url: '',
    created_at: repo.createdAt,
    updated_at: repo.updatedAt,
    pushed_at: repo.updatedAt,
    size: 0,
    stargazers_count: 0,
    watchers_count: 0,
    language: null,
    forks_count: 0,
    open_issues_count: [...repo.issues.values()].filter((issue) => issue.state === 'open').length,
    default_branch: repo.defaultBranch,
    visibility: repo.isPrivate ? 'private' : 'public',
    archived: false,
    disabled: false,
  };
}

/** The issue object as REST returns it (labels as {name} objects). */
export function issueJson(repo: RepoRec, issue: IssueRec): Record<string, unknown> {
  return {
    id: issue.id,
    node_id: Buffer.from(`05:Issue${issue.id}`).toString('base64'),
    number: issue.number,
    title: issue.title,
    body: issue.body ?? '',
    state: issue.state,
    labels: issue.labels.map((name) => {
      const label = repo.labels.get(name);
      return { id: 0, name, color: label?.color ?? 'ededed', description: label?.description ?? null, default: false };
    }),
    user: userJson(),
    comments: issue.comments.length,
    created_at: issue.createdAt,
    updated_at: issue.updatedAt,
    closed_at: issue.state === 'closed' ? issue.updatedAt : null,
    html_url: '',
    url: '',
  };
}

/** The pull request object as REST returns it. */
export function pullJson(repo: RepoRec, pull: PullRec): Record<string, unknown> {
  return {
    id: pull.id,
    node_id: Buffer.from(`09:PullRequest${pull.id}`).toString('base64'),
    number: pull.number,
    title: pull.title,
    body: pull.body ?? '',
    state: pull.state,
    user: userJson(),
    head: { label: `${repo.owner}:${pull.headRef}`, ref: pull.headRef, sha: pull.headSha, user: userJson(), repo: repoJson(repo) },
    base: { label: `${repo.owner}:${pull.baseRef}`, ref: pull.baseRef, sha: pull.baseSha, user: userJson(), repo: repoJson(repo) },
    merged: pull.merged,
    merged_at: pull.merged ? pull.updatedAt : null,
    merge_commit_sha: pull.mergeCommitSha,
    mergeable: null,
    draft: false,
    created_at: pull.createdAt,
    updated_at: pull.updatedAt,
    closed_at: pull.state === 'closed' ? pull.updatedAt : null,
    html_url: '',
    url: '',
  };
}

/** Resolve a ref parameter (branch name, full ref, or sha) to a commit sha. */
export function resolveRef(repo: RepoRec, ref: string | null | undefined): string | null {
  if (ref === null || ref === undefined || ref === '') return store.branchTip(repo, repo.defaultBranch);
  if (repo.refs.has(ref)) return repo.refs.get(ref) as string;
  if (repo.refs.has(`refs/heads/${ref}`)) return repo.refs.get(`refs/heads/${ref}`) as string;
  const object = getObject(repo, ref);
  if (object !== null && object.type === 'commit') return ref;
  return null;
}

/** Read a file's bytes at a commit, or null. */
function readFileAt(repo: RepoRec, commitSha: string, path: string): Buffer | null {
  const commit = getObject(repo, commitSha);
  if (commit === null || commit.type !== 'commit') return null;
  const files = flattenTree(repo, parseCommit(commit.data).tree);
  const entry = files.get(path);
  if (entry === undefined) return null;
  const blob = getObject(repo, entry.sha);
  return blob === null ? null : blob.data;
}

/** The flattened file map at a commit sha. */
function filesAt(repo: RepoRec, commitSha: string): Map<string, { mode: string; sha: string }> {
  const commit = getObject(repo, commitSha);
  if (commit === null || commit.type !== 'commit') return new Map();
  return flattenTree(repo, parseCommit(commit.data).tree);
}

/** Line-diff two texts into added/deleted line counts (LCS over lines). */
export function lineDiffCounts(oldText: string, newText: string): { additions: number; deletions: number } {
  const a = oldText === '' ? [] : oldText.split('\n');
  const b = newText === '' ? [] : newText.split('\n');
  const m = a.length;
  const n = b.length;
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array<number>(n + 1).fill(0));
  for (let i = m - 1; i >= 0; i -= 1) {
    for (let j = n - 1; j >= 0; j -= 1) {
      dp[i][j] = a[i] === b[j] ? (dp[i + 1][j + 1] as number) + 1 : Math.max(dp[i + 1][j] as number, dp[i][j + 1] as number);
    }
  }
  const common = dp[0][0] as number;
  return { additions: n - common, deletions: m - common };
}

/**
 * Create a commit on a branch from a full file map (path -> bytes).
 * Handles the unborn-branch case (no parent). Returns the commit sha.
 */
function commitFiles(repo: RepoRec, branch: string, files: Map<string, Buffer>, message: string): string {
  const blobShas = new Map<string, string>();
  for (const [path, bytes] of files) blobShas.set(path, putObject(repo, 'blob', bytes));
  const tree = buildTree(repo, blobShas);
  const parent = store.branchTip(repo, branch);
  const sha = store.commit(repo, tree, parent === null ? [] : [parent], message);
  repo.refs.set(`refs/heads/${branch}`, sha);
  repo.updatedAt = store.nowIso();
  return sha;
}

/** The current file map (path -> bytes) at a branch tip. */
function branchFiles(repo: RepoRec, branch: string): Map<string, Buffer> {
  const tip = store.branchTip(repo, branch);
  const out = new Map<string, Buffer>();
  if (tip === null) return out;
  for (const [path, entry] of filesAt(repo, tip)) {
    const blob = getObject(repo, entry.sha);
    if (blob !== null) out.set(path, blob.data);
  }
  return out;
}

/** Route one /api/v3 request. Segments are the path after /api/v3. */
export function handleRest(ctx: Ctx): void {
  const seg = ctx.segments.slice(2);
  if (ctx.jsonError && ctx.method !== 'GET' && ctx.method !== 'DELETE') {
    sendError(ctx, 400, 'Problems parsing JSON');
    return;
  }
  const body = ctx.json ?? {};

  // The API root and meta are not scoped to a repository.
  if (seg.length === 0) {
    if (ctx.method === 'GET') {
      sendJson(
        ctx,
        200,
        {
          current_user_url: '/api/v3/user',
          current_user_repositories_url: '/api/v3/user/repos',
          repository_url: '/api/v3/repos/{owner}/{repo}',
          rate_limit_url: '/api/v3/rate_limit',
        },
        { 'x-oauth-scopes': 'repo, read:org' },
      );
      return;
    }
    sendError(ctx, 404, 'Not Found');
    return;
  }
  if (seg[0] === 'meta' && seg.length === 1 && ctx.method === 'GET') {
    sendJson(ctx, 200, { installed_version: INSTALLED_VERSION, hooks: [], verifiable_password_authentication: false });
    return;
  }
  if (seg[0] === 'user' && seg.length === 1 && ctx.method === 'GET') {
    sendJson(ctx, 200, userJson());
    return;
  }
  if (seg[0] === 'user' && seg[1] === 'repos' && seg.length === 2) {
    if (ctx.method === 'GET') return listUserRepos(ctx);
    if (ctx.method === 'POST') return createRepoRoute(ctx, body);
  }
  if (seg[0] === 'repos' && seg.length >= 3) {
    const repo = store.getRepo(seg[1] as string, seg[2] as string);
    if (repo === null) {
      sendError(ctx, 404, 'Not Found');
      return;
    }
    return handleRepo(ctx, repo, seg.slice(3), body);
  }
  sendError(ctx, 404, 'Not Found');
}

function listUserRepos(ctx: Ctx): void {
  const perPage = Math.max(1, Math.min(100, Number(ctx.query.get('per_page') ?? '30') || 30));
  const page = Math.max(1, Number(ctx.query.get('page') ?? '1') || 1);
  const all = store.listRepos();
  const slice = all.slice((page - 1) * perPage, page * perPage);
  const headers: Record<string, string> = {};
  if (page * perPage < all.length) {
    const host = ctx.req.headers.host ?? 'entry';
    const next = `http://${host}/api/v3/user/repos?per_page=${perPage}&page=${page + 1}`;
    const last = `http://${host}/api/v3/user/repos?per_page=${perPage}&page=${Math.ceil(all.length / perPage)}`;
    headers.link = `<${next}>; rel="next", <${last}>; rel="last"`;
  }
  sendJson(ctx, 200, slice.map(repoJson), headers);
}

function createRepoRoute(ctx: Ctx, body: Record<string, unknown>): void {
  const name = str(body, 'name');
  if (name === null || name === '') {
    sendError(ctx, 422, 'Validation Failed: name is required');
    return;
  }
  const repo = store.createRepo(name, {
    description: str(body, 'description') ?? '',
    isPrivate: bool(body, 'private') ?? false,
    defaultBranch: 'main',
  });
  if (repo === null) {
    sendError(ctx, 422, 'Validation Failed: name already exists on this account');
    return;
  }
  sendJson(ctx, 201, repoJson(repo));
}

/** Routes under /repos/{owner}/{repo}/... */
function handleRepo(ctx: Ctx, repo: RepoRec, seg: string[], body: Record<string, unknown>): void {
  if (seg.length === 0) {
    if (ctx.method === 'GET') return sendJson(ctx, 200, repoJson(repo));
    if (ctx.method === 'PATCH') {
      const description = str(body, 'description');
      if (description !== null) repo.description = description;
      const name = str(body, 'name');
      if (name !== null && name !== repo.name) repo.name = name;
      const isPrivate = bool(body, 'private');
      if (isPrivate !== null) repo.isPrivate = isPrivate;
      const defaultBranch = str(body, 'default_branch');
      if (defaultBranch !== null) repo.defaultBranch = defaultBranch;
      repo.updatedAt = store.nowIso();
      return sendJson(ctx, 200, repoJson(repo));
    }
    if (ctx.method === 'DELETE') {
      store.deleteRepo(repo.owner, repo.name);
      ctx.res.writeHead(204, { 'x-github-request-id': store.nextRequestId() });
      ctx.res.end();
      return;
    }
    return sendError(ctx, 404, 'Not Found');
  }

  const [head, ...rest] = seg as [string, ...string[]];

  if (head === 'git' && rest[0] === 'refs') {
    if (ctx.method === 'POST' && rest.length === 1) {
      const ref = str(body, 'ref');
      const sha = str(body, 'sha');
      if (ref === null || sha === null || getObject(repo, sha) === null) {
        return sendError(ctx, 422, 'Validation Failed: ref and sha are required');
      }
      repo.refs.set(ref, sha);
      return sendJson(ctx, 201, { ref, node_id: '', object: { sha, type: 'commit', url: '' }, url: '' });
    }
    if (ctx.method === 'GET' && rest.length >= 2) {
      const ref = `refs/${rest.slice(1).join('/')}`;
      const sha = repo.refs.get(ref);
      if (sha === undefined) return sendError(ctx, 404, 'Not Found');
      return sendJson(ctx, 200, { ref, node_id: '', object: { sha, type: 'commit', url: '' }, url: '' });
    }
    return sendError(ctx, 404, 'Not Found');
  }

  if (head === 'branches' && ctx.method === 'GET') {
    if (rest.length === 0) {
      const branches = [...repo.refs.entries()]
        .filter(([ref]) => ref.startsWith('refs/heads/'))
        .map(([ref, sha]) => ({ name: ref.slice('refs/heads/'.length), commit: { sha, url: '' }, protected: false }));
      return sendJson(ctx, 200, branches);
    }
    const sha = store.branchTip(repo, rest.join('/'));
    if (sha === null) return sendError(ctx, 404, 'Not Found');
    return sendJson(ctx, 200, { name: rest.join('/'), commit: { sha, url: '' }, protected: false });
  }

  if (head === 'commits' && ctx.method === 'GET' && rest.length === 0) {
    const tip = resolveRef(repo, ctx.query.get('sha'));
    if (tip === null) return sendJson(ctx, 200, []);
    const commits = store.history(repo, tip).map((sha) => {
      const info = parseCommit((getObject(repo, sha) as { data: Buffer }).data);
      return {
        sha,
        node_id: '',
        commit: {
          message: info.message.replace(/\n+$/, ''),
          tree: { sha: info.tree, url: '' },
          author: { name: VIEWER.name, email: VIEWER.email, date: repo.updatedAt },
          committer: { name: VIEWER.name, email: VIEWER.email, date: repo.updatedAt },
          url: '',
          comment_count: 0,
        },
        author: userJson(),
        committer: userJson(),
        parents: info.parents.map((parent) => ({ sha: parent, url: '' })),
        url: '',
      };
    });
    return sendJson(ctx, 200, commits);
  }

  if (head === 'contents') return handleContents(ctx, repo, rest.join('/'), body);
  if (head === 'labels') return handleLabels(ctx, repo, rest, body);
  if (head === 'issues') return handleIssues(ctx, repo, rest, body);
  if (head === 'pulls') return handlePulls(ctx, repo, rest, body);
  return sendError(ctx, 404, 'Not Found');
}

function handleContents(ctx: Ctx, repo: RepoRec, path: string, body: Record<string, unknown>): void {
  if (ctx.method === 'PUT') {
    const message = str(body, 'message') ?? '';
    const contentB64 = str(body, 'content');
    if (contentB64 === null) return sendError(ctx, 422, 'Validation Failed: content is required');
    const branch = str(body, 'branch') ?? repo.defaultBranch;
    const bytes = Buffer.from(contentB64.replace(/\s+/g, ''), 'base64');
    const files = branchFiles(repo, branch);
    const existing = files.get(path);
    const givenSha = str(body, 'sha');
    if (existing !== undefined) {
      const existingSha = putObject(repo, 'blob', existing);
      if (givenSha === null) return sendError(ctx, 422, 'Validation Failed: sha is required when updating a file');
      if (givenSha !== existingSha) return sendError(ctx, 409, 'Conflict: the sha does not match the current file');
    } else if (givenSha !== null) {
      return sendError(ctx, 404, 'Not Found');
    }
    files.set(path, bytes);
    const commitSha = commitFiles(repo, branch, files, message);
    const blobSha = putObject(repo, 'blob', bytes);
    return sendJson(ctx, existing === undefined ? 201 : 200, {
      content: { name: path.split('/').pop(), path, sha: blobSha, size: bytes.length, type: 'file', encoding: 'base64', url: '', html_url: '', git_url: '', download_url: '' },
      commit: { sha: commitSha, url: '', html_url: '', author: { name: VIEWER.name, email: VIEWER.email, date: repo.updatedAt }, committer: { name: VIEWER.name, email: VIEWER.email, date: repo.updatedAt }, message, tree: { sha: '', url: '' }, parents: [] },
    });
  }
  if (ctx.method === 'GET') {
    const commitSha = resolveRef(repo, ctx.query.get('ref'));
    if (commitSha === null) return sendError(ctx, 404, 'Not Found');
    const commit = getObject(repo, commitSha);
    if (commit === null || commit.type !== 'commit') return sendError(ctx, 404, 'Not Found');
    const treeSha = parseCommit(commit.data).tree;
    if (path === '') {
      return sendJson(ctx, 200, dirListing(repo, treeSha, ''));
    }
    // Walk to the target entry.
    const segments = path.split('/');
    let currentTree = treeSha;
    for (let i = 0; i < segments.length; i += 1) {
      const tree = getObject(repo, currentTree);
      if (tree === null || tree.type !== 'tree') return sendError(ctx, 404, 'Not Found');
      const entry = parseTree(tree.data).find((candidate) => candidate.name === segments[i]);
      if (entry === undefined) return sendError(ctx, 404, 'Not Found');
      const isLast = i === segments.length - 1;
      if (!isLast) {
        if (entry.mode !== '40000') return sendError(ctx, 404, 'Not Found');
        currentTree = entry.sha;
        continue;
      }
      if (entry.mode === '40000') {
        return sendJson(ctx, 200, dirListing(repo, entry.sha, path));
      }
      const blob = getObject(repo, entry.sha);
      if (blob === null) return sendError(ctx, 404, 'Not Found');
      return sendJson(ctx, 200, {
        type: 'file',
        encoding: 'base64',
        content: blob.data.toString('base64'),
        name: entry.name,
        path,
        sha: entry.sha,
        size: blob.data.length,
        url: '',
        html_url: '',
        git_url: '',
        download_url: '',
      });
    }
    return sendError(ctx, 404, 'Not Found');
  }
  if (ctx.method === 'DELETE') {
    const message = str(body, 'message') ?? '';
    const branch = str(body, 'branch') ?? repo.defaultBranch;
    const givenSha = str(body, 'sha');
    const files = branchFiles(repo, branch);
    const existing = files.get(path);
    if (existing === undefined) return sendError(ctx, 404, 'Not Found');
    if (givenSha !== null && givenSha !== putObject(repo, 'blob', existing)) {
      return sendError(ctx, 409, 'Conflict: the sha does not match the current file');
    }
    files.delete(path);
    const commitSha = commitFiles(repo, branch, files, message);
    return sendJson(ctx, 200, { content: null, commit: { sha: commitSha, url: '', message } });
  }
  return sendError(ctx, 404, 'Not Found');
}

/** A directory listing in the contents API's shape. */
function dirListing(repo: RepoRec, treeSha: string, prefix: string): Record<string, unknown>[] {
  const tree = getObject(repo, treeSha);
  if (tree === null || tree.type !== 'tree') return [];
  return parseTree(tree.data).map((entry) => ({
    type: entry.mode === '40000' ? 'dir' : 'file',
    name: entry.name,
    path: prefix === '' ? entry.name : `${prefix}/${entry.name}`,
    sha: entry.sha,
    size: 0,
    url: '',
    html_url: '',
    git_url: '',
    download_url: null,
  }));
}

function handleLabels(ctx: Ctx, repo: RepoRec, seg: string[], body: Record<string, unknown>): void {
  if (ctx.method === 'POST' && seg.length === 0) {
    const name = str(body, 'name');
    if (name === null || name === '') return sendError(ctx, 422, 'Validation Failed: name is required');
    if (repo.labels.has(name)) return sendError(ctx, 422, 'Validation Failed: name already exists');
    const label = { name, color: (str(body, 'color') ?? 'ededed').replace(/^#/, ''), description: str(body, 'description') };
    repo.labels.set(name, label);
    return sendJson(ctx, 201, { id: 0, node_id: '', name: label.name, color: label.color, description: label.description, default: false, url: '' });
  }
  if (ctx.method === 'GET' && seg.length === 0) {
    return sendJson(ctx, 200, [...repo.labels.values()].map((label) => ({ id: 0, name: label.name, color: label.color, description: label.description, default: false, url: '' })));
  }
  return sendError(ctx, 404, 'Not Found');
}

/** Validate a label list for an issue write; returns an error message or null. */
function labelError(repo: RepoRec, body: Record<string, unknown>): string | null {
  const labels = body.labels;
  if (labels === undefined) return null;
  if (!Array.isArray(labels)) return 'Validation Failed: labels must be a list';
  for (const item of labels) {
    const name = typeof item === 'string' ? item : typeof item === 'object' && item !== null ? String((item as { name?: unknown }).name ?? '') : '';
    if (!repo.labels.has(name)) return `Validation Failed: label "${name}" does not exist`;
  }
  return null;
}

/** The label names a write body carries. */
function labelNames(body: Record<string, unknown>): string[] {
  const labels = body.labels;
  if (!Array.isArray(labels)) return [];
  return labels.map((item) => (typeof item === 'string' ? item : String((item as { name?: unknown }).name ?? '')));
}

function handleIssues(ctx: Ctx, repo: RepoRec, seg: string[], body: Record<string, unknown>): void {
  if (seg.length === 0) {
    if (ctx.method === 'POST') {
      const title = str(body, 'title');
      if (title === null || title === '') return sendError(ctx, 422, 'Validation Failed: title is required');
      const bad = labelError(repo, body);
      if (bad !== null) return sendError(ctx, 422, bad);
      const now = store.nowIso();
      const issue: IssueRec = {
        id: store.nextIssueId(),
        number: repo.nextNumber++,
        title,
        body: str(body, 'body'),
        state: 'open',
        labels: labelNames(body),
        comments: [],
        user: VIEWER.login,
        createdAt: now,
        updatedAt: now,
      };
      repo.issues.set(issue.number, issue);
      return sendJson(ctx, 201, issueJson(repo, issue));
    }
    if (ctx.method === 'GET') {
      const state = ctx.query.get('state') ?? 'open';
      const sort = ctx.query.get('sort') ?? 'created';
      const direction = ctx.query.get('direction') ?? 'desc';
      let list = [...repo.issues.values()];
      if (state !== 'all') list = list.filter((issue) => issue.state === state);
      list.sort((a, b) => (sort === 'updated' ? a.updatedAt.localeCompare(b.updatedAt) || a.number - b.number : a.number - b.number));
      if (direction !== 'asc') list.reverse();
      return sendJson(ctx, 200, list.map((issue) => issueJson(repo, issue)));
    }
    return sendError(ctx, 404, 'Not Found');
  }
  const number = Number(seg[0]);
  const issue = Number.isInteger(number) ? repo.issues.get(number) : undefined;
  if (seg[1] === 'comments') {
    if (issue === undefined) return sendError(ctx, 404, 'Not Found');
    if (ctx.method === 'POST' && seg.length === 2) {
      const text = str(body, 'body');
      if (text === null) return sendError(ctx, 422, 'Validation Failed: body is required');
      const now = store.nowIso();
      const comment = { id: store.nextCommentId(), body: text, user: VIEWER.login, createdAt: now, updatedAt: now };
      issue.comments.push(comment);
      return sendJson(ctx, 201, { id: comment.id, node_id: '', body: comment.body, user: userJson(), created_at: now, updated_at: now, html_url: '', url: '', issue_url: '' });
    }
    if (ctx.method === 'GET' && seg.length === 2) {
      return sendJson(ctx, 200, issue.comments.map((comment) => ({ id: comment.id, node_id: '', body: comment.body, user: userJson(), created_at: comment.createdAt, updated_at: comment.updatedAt, html_url: '', url: '', issue_url: '' })));
    }
    return sendError(ctx, 404, 'Not Found');
  }
  if (issue === undefined) return sendError(ctx, 404, 'Not Found');
  if (ctx.method === 'GET' && seg.length === 1) return sendJson(ctx, 200, issueJson(repo, issue));
  if (ctx.method === 'PATCH' && seg.length === 1) {
    const bad = labelError(repo, body);
    if (bad !== null) return sendError(ctx, 422, bad);
    const title = str(body, 'title');
    if (title !== null) issue.title = title;
    if ('body' in body) issue.body = str(body, 'body');
    const state = str(body, 'state');
    if (state === 'open' || state === 'closed') issue.state = state;
    if (body.labels !== undefined) issue.labels = labelNames(body);
    issue.updatedAt = store.nowIso();
    return sendJson(ctx, 200, issueJson(repo, issue));
  }
  return sendError(ctx, 404, 'Not Found');
}

function handlePulls(ctx: Ctx, repo: RepoRec, seg: string[], body: Record<string, unknown>): void {
  if (seg.length === 0) {
    if (ctx.method === 'POST') {
      const title = str(body, 'title') ?? '';
      const headRaw = str(body, 'head') ?? '';
      const baseRaw = str(body, 'base') ?? '';
      const head = headRaw.includes(':') ? (headRaw.split(':').pop() as string) : headRaw;
      const base = baseRaw.includes(':') ? (baseRaw.split(':').pop() as string) : baseRaw;
      const headSha = store.branchTip(repo, head);
      const baseSha = store.branchTip(repo, base);
      if (headSha === null || baseSha === null) {
        return sendError(ctx, 422, 'Validation Failed: head or base branch does not exist');
      }
      const now = store.nowIso();
      const pull: PullRec = {
        id: store.nextIssueId(),
        number: repo.nextNumber++,
        title,
        body: str(body, 'body'),
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
      return sendJson(ctx, 201, pullJson(repo, pull));
    }
    if (ctx.method === 'GET') {
      const state = ctx.query.get('state') ?? 'open';
      let list = [...repo.pulls.values()];
      if (state !== 'all') list = list.filter((pull) => pull.state === state);
      list.sort((a, b) => b.number - a.number);
      return sendJson(ctx, 200, list.map((pull) => pullJson(repo, pull)));
    }
    return sendError(ctx, 404, 'Not Found');
  }
  const number = Number(seg[0]);
  const pull = Number.isInteger(number) ? repo.pulls.get(number) : undefined;
  if (pull === undefined) return sendError(ctx, 404, 'Not Found');
  if (ctx.method === 'GET' && seg.length === 1) return sendJson(ctx, 200, pullJson(repo, pull));
  if (ctx.method === 'GET' && seg[1] === 'files' && seg.length === 2) {
    return sendJson(ctx, 200, pullFiles(repo, pull));
  }
  if (ctx.method === 'PUT' && seg[1] === 'merge' && seg.length === 2) {
    return mergePullRoute(ctx, repo, pull, body);
  }
  return sendError(ctx, 404, 'Not Found');
}

/** The changed-file list between a pull's merge base and its head. */
export function pullFiles(repo: RepoRec, pull: PullRec): Record<string, unknown>[] {
  const current = refreshPull(repo, pull);
  const base = store.mergeBase(repo, current.baseSha, current.headSha) ?? current.baseSha;
  const before = filesAt(repo, base);
  const after = filesAt(repo, current.headSha);
  const out: Record<string, unknown>[] = [];
  const paths = new Set([...before.keys(), ...after.keys()]);
  for (const path of [...paths].sort()) {
    const oldEntry = before.get(path);
    const newEntry = after.get(path);
    if (oldEntry?.sha === newEntry?.sha) continue;
    const oldText = oldEntry === undefined ? '' : (getObject(repo, oldEntry.sha)?.data.toString('utf8') ?? '');
    const newText = newEntry === undefined ? '' : (getObject(repo, newEntry.sha)?.data.toString('utf8') ?? '');
    const counts = lineDiffCounts(oldText, newText);
    out.push({
      sha: newEntry?.sha ?? oldEntry?.sha ?? '',
      filename: path,
      status: oldEntry === undefined ? 'added' : newEntry === undefined ? 'removed' : 'modified',
      additions: counts.additions,
      deletions: counts.deletions,
      changes: counts.additions + counts.deletions,
      blob_url: '',
      raw_url: '',
      contents_url: '',
    });
  }
  return out;
}

/** Re-read a pull's branch tips (branches move after the pull opens). */
export function refreshPull(repo: RepoRec, pull: PullRec): PullRec {
  const headSha = store.branchTip(repo, pull.headRef);
  const baseSha = store.branchTip(repo, pull.baseRef);
  if (headSha !== null) pull.headSha = headSha;
  if (baseSha !== null) pull.baseSha = baseSha;
  return pull;
}

/**
 * The three-way tree merge at a pull's heart: returns the merged
 * path -> blob-sha map, or null when a file changed on both sides with
 * different results (a conflict).
 */
export function mergedTreeMap(repo: RepoRec, pull: PullRec): Map<string, string> | null {
  const current = refreshPull(repo, pull);
  const baseTip = store.branchTip(repo, current.baseRef);
  const headTip = store.branchTip(repo, current.headRef);
  if (baseTip === null || headTip === null) return null;
  const base = store.mergeBase(repo, baseTip, headTip);
  const baseFiles = filesAt(repo, base ?? baseTip);
  const ourFiles = filesAt(repo, baseTip);
  const theirFiles = filesAt(repo, headTip);
  const merged = new Map<string, string>();
  const paths = new Set([...baseFiles.keys(), ...ourFiles.keys(), ...theirFiles.keys()]);
  for (const path of paths) {
    const inBase = baseFiles.get(path)?.sha;
    const inOurs = ourFiles.get(path)?.sha;
    const inTheirs = theirFiles.get(path)?.sha;
    if (inOurs === inTheirs) {
      if (inOurs !== undefined) merged.set(path, inOurs);
    } else if (inBase === inOurs) {
      if (inTheirs !== undefined) merged.set(path, inTheirs);
    } else if (inBase === inTheirs) {
      if (inOurs !== undefined) merged.set(path, inOurs);
    } else {
      return null;
    }
  }
  return merged;
}

/** True when a pull's three-way merge conflicts (or its branches are gone). */
export function pullHasConflict(repo: RepoRec, pull: PullRec): boolean {
  if (pull.state !== 'open') return false;
  return mergedTreeMap(repo, pull) === null;
}

/**
 * Apply the squash merge: one new commit on the base branch whose tree is
 * the merged tree. Returns the new commit sha, or null when the pull is
 * not open or the merge conflicts.
 */
export function performSquashMerge(repo: RepoRec, pull: PullRec, message?: string): string | null {
  const current = refreshPull(repo, pull);
  if (current.state !== 'open' || current.merged) return null;
  const merged = mergedTreeMap(repo, current);
  if (merged === null) return null;
  const baseTip = store.branchTip(repo, current.baseRef);
  if (baseTip === null) return null;
  const tree = buildTree(repo, merged);
  const text = message ?? `${current.title} (#${current.number})`;
  const sha = store.commit(repo, tree, [baseTip], text);
  repo.refs.set(`refs/heads/${current.baseRef}`, sha);
  current.state = 'closed';
  current.merged = true;
  current.mergeCommitSha = sha;
  current.baseSha = sha;
  current.updatedAt = store.nowIso();
  repo.updatedAt = current.updatedAt;
  return sha;
}

function mergePullRoute(ctx: Ctx, repo: RepoRec, pull: PullRec, body: Record<string, unknown>): void {
  const current = refreshPull(repo, pull);
  if (current.state !== 'open' || current.merged) {
    return sendError(ctx, 405, 'Pull Request is not mergeable');
  }
  const title = str(body, 'commit_title') ?? `${current.title} (#${current.number})`;
  const message = str(body, 'commit_message') ?? title;
  const sha = performSquashMerge(repo, current, message);
  if (sha === null) {
    return sendError(ctx, 405, 'Pull Request has merge conflicts');
  }
  return sendJson(ctx, 200, { sha, merged: true, message: 'Pull Request successfully merged' });
}
