// The forge's whole state: one viewer, their repositories, and inside each
// repository a small git object store plus the issue / pull-request records
// the REST, GraphQL and MCP surfaces all share. Everything lives in memory:
// a trial is one process and one fresh server, so nothing persists.
//
// Determinism is a hard rule of the contest (a trial is replayed and the
// exports compared), so this module never reads the wall clock or a random
// source: timestamps come from MAKEFUN_TRIAL_NOW plus a per-store tick
// counter, and every id is a plain sequence number.

import { createHash } from 'node:crypto';

/** The one login the trial's token names (wire.ts's fixed scenario viewer). */
export const VIEWER = {
  id: 1000,
  login: 'adaiversen',
  name: 'ada iversen',
  email: 'adaiversen@example.invalid',
} as const;

/** Installed version string the /meta route reports; any non-empty value passes. */
export const INSTALLED_VERSION = '1.0.0-forge.1';

/** The base instant every timestamp in a trial derives from. */
function trialEpochMs(): number {
  const raw = process.env.MAKEFUN_TRIAL_NOW;
  if (raw !== undefined && raw !== '') {
    const parsed = Date.parse(raw);
    if (Number.isFinite(parsed)) return parsed;
    const asNumber = Number(raw);
    if (Number.isFinite(asNumber)) return asNumber;
  }
  return Date.parse('2026-01-01T00:00:00.000Z');
}

export type GitObjectType = 'blob' | 'tree' | 'commit' | 'tag';

export interface GitObject {
  type: GitObjectType;
  /** The object's raw content (for a commit or tree, its serialized bytes). */
  data: Buffer;
}

export interface LabelRec {
  name: string;
  color: string;
  description: string | null;
}

export interface CommentRec {
  id: number;
  body: string;
  user: string;
  createdAt: string;
  updatedAt: string;
}

export interface IssueRec {
  id: number;
  number: number;
  title: string;
  body: string | null;
  state: 'open' | 'closed';
  labels: string[];
  comments: CommentRec[];
  user: string;
  createdAt: string;
  updatedAt: string;
}

export interface PullRec {
  id: number;
  number: number;
  title: string;
  body: string | null;
  state: 'open' | 'closed';
  /** Branch names as the REST API speaks them ("feature", not refs/heads/feature). */
  headRef: string;
  baseRef: string;
  headSha: string;
  baseSha: string;
  merged: boolean;
  mergeCommitSha: string | null;
  comments: CommentRec[];
  user: string;
  createdAt: string;
  updatedAt: string;
}

export interface RepoRec {
  id: number;
  name: string;
  owner: string;
  description: string;
  isPrivate: boolean;
  defaultBranch: string;
  createdAt: string;
  updatedAt: string;
  /** sha -> object, this repository's private object store. */
  objects: Map<string, GitObject>;
  /** Full ref name (refs/heads/main) -> commit sha. */
  refs: Map<string, string>;
  labels: Map<string, LabelRec>;
  issues: Map<number, IssueRec>;
  pulls: Map<number, PullRec>;
  /** Issues and pull requests share one number sequence, as on GitHub. */
  nextNumber: number;
}

/** sha1 of a git object: sha1("<type> <length>\0" + data), hex encoded. */
export function hashObject(type: GitObjectType, data: Buffer): string {
  const header = Buffer.from(`${type} ${data.length}\0`, 'utf8');
  return createHash('sha1').update(header).update(data).digest('hex');
}

/** Store an object in a repository and return its sha (idempotent). */
export function putObject(repo: RepoRec, type: GitObjectType, data: Buffer): string {
  const sha = hashObject(type, data);
  if (!repo.objects.has(sha)) repo.objects.set(sha, { type, data });
  return sha;
}

export function getObject(repo: RepoRec, sha: string): GitObject | null {
  return repo.objects.get(sha) ?? null;
}

/** One parsed tree entry: mode as git writes it ("100644", "40000" for a subtree). */
export interface TreeEntry {
  mode: string;
  name: string;
  sha: string;
}

/** Parse a raw tree object into its entries. */
export function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let offset = 0;
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset);
    const nul = data.indexOf(0x00, space);
    const mode = data.toString('utf8', offset, space);
    const name = data.toString('utf8', space + 1, nul);
    const sha = data.toString('hex', nul + 1, nul + 21);
    entries.push({ mode, name, sha });
    offset = nul + 21;
  }
  return entries;
}

/** Serialize tree entries the git way: sorted by name, subtrees as if suffixed with "/". */
export function serializeTree(entries: TreeEntry[]): Buffer {
  const sorted = [...entries].sort((a, b) => {
    const ka = a.mode === '40000' ? `${a.name}/` : a.name;
    const kb = b.mode === '40000' ? `${b.name}/` : b.name;
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  });
  const parts: Buffer[] = [];
  for (const entry of sorted) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'));
    parts.push(Buffer.from(entry.sha, 'hex'));
  }
  return Buffer.concat(parts);
}

/** A flattened file listing of a tree: path -> {mode, sha} for every blob under it. */
export function flattenTree(repo: RepoRec, treeSha: string, prefix = '', out = new Map<string, { mode: string; sha: string }>()): Map<string, { mode: string; sha: string }> {
  const tree = getObject(repo, treeSha);
  if (tree === null || tree.type !== 'tree') return out;
  for (const entry of parseTree(tree.data)) {
    const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
    if (entry.mode === '40000') flattenTree(repo, entry.sha, path, out);
    else out.set(path, { mode: entry.mode, sha: entry.sha });
  }
  return out;
}

/**
 * Build (and store) the nested tree for a full path -> blob-sha map.
 * Returns the root tree's sha. An empty map yields the empty tree.
 */
export function buildTree(repo: RepoRec, files: Map<string, string>): string {
  interface Dir {
    files: Map<string, string>;
    dirs: Map<string, Dir>;
  }
  const root: Dir = { files: new Map(), dirs: new Map() };
  for (const [path, sha] of files) {
    const segments = path.split('/');
    let dir = root;
    for (const segment of segments.slice(0, -1)) {
      let next = dir.dirs.get(segment);
      if (next === undefined) {
        next = { files: new Map(), dirs: new Map() };
        dir.dirs.set(segment, next);
      }
      dir = next;
    }
    dir.files.set(segments[segments.length - 1] as string, sha);
  }
  const writeDir = (dir: Dir): string => {
    const entries: TreeEntry[] = [];
    for (const [name, sha] of dir.files) entries.push({ mode: '100644', name, sha });
    for (const [name, sub] of dir.dirs) entries.push({ mode: '40000', name, sha: writeDir(sub) });
    return putObject(repo, 'tree', serializeTree(entries));
  };
  return writeDir(root);
}

/** The parsed pieces of a commit object the forge needs. */
export interface CommitInfo {
  tree: string;
  parents: string[];
  message: string;
  authorLine: string;
  committerLine: string;
}

/** Parse a raw commit object. */
export function parseCommit(data: Buffer): CommitInfo {
  // Decode the header alone for the line scan, and the message apart: the
  // byte index of the blank line is the char index too (a 0x0a byte never
  // appears inside a multi-byte utf8 sequence).
  const split = data.indexOf('\n\n');
  const head = split === -1 ? data.toString('utf8') : data.toString('utf8', 0, split);
  const message = split === -1 ? '' : data.toString('utf8', split + 2);
  let tree = '';
  let authorLine = '';
  let committerLine = '';
  const parents: string[] = [];
  for (const line of head.split('\n')) {
    if (line.startsWith('tree ')) tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) parents.push(line.slice(7).trim());
    else if (line.startsWith('author ')) authorLine = line.slice(7);
    else if (line.startsWith('committer ')) committerLine = line.slice(10);
  }
  return { tree, parents, message, authorLine, committerLine };
}

export class Store {
  readonly repos = new Map<string, RepoRec>();
  private readonly epochMs = trialEpochMs();
  private tickCount = 0;
  private repoSeq = 100_000;
  private issueSeq = 1_000_000;
  private commentSeq = 2_000_000;
  private requestSeq = 0;

  /** The next deterministic timestamp: the trial's opening instant plus one tick per call. */
  nowIso(): string {
    this.tickCount += 1;
    return new Date(this.epochMs + this.tickCount * 1000).toISOString();
  }

  /** The same instant as a unix-seconds count, for git author/committer lines. */
  nowUnix(): number {
    return Math.floor(this.epochMs / 1000) + this.tickCount;
  }

  /** A deterministic, non-empty X-GitHub-Request-Id value. */
  nextRequestId(): string {
    this.requestSeq += 1;
    return this.requestSeq.toString(16).toUpperCase().padStart(8, '0');
  }

  /** Create a repository owned by the viewer; null when the name is taken. */
  createRepo(name: string, init: { description?: string; isPrivate?: boolean; defaultBranch?: string }): RepoRec | null {
    const key = `${VIEWER.login}/${name}`;
    if (this.repos.has(key)) return null;
    const now = this.nowIso();
    const repo: RepoRec = {
      id: (this.repoSeq += 1),
      name,
      owner: VIEWER.login,
      description: init.description ?? '',
      isPrivate: init.isPrivate ?? false,
      defaultBranch: init.defaultBranch ?? 'main',
      createdAt: now,
      updatedAt: now,
      objects: new Map(),
      refs: new Map(),
      labels: new Map(),
      issues: new Map(),
      pulls: new Map(),
      nextNumber: 1,
    };
    this.repos.set(key, repo);
    return repo;
  }

  /** Look a repository up by owner/name; only the viewer's own ever resolve. */
  getRepo(owner: string, name: string): RepoRec | null {
    if (owner !== VIEWER.login) return null;
    return this.repos.get(`${owner}/${name}`) ?? null;
  }

  deleteRepo(owner: string, name: string): boolean {
    if (owner !== VIEWER.login) return false;
    return this.repos.delete(`${owner}/${name}`);
  }

  listRepos(): RepoRec[] {
    return [...this.repos.values()].sort((a, b) => a.id - b.id);
  }

  nextIssueId(): number {
    return (this.issueSeq += 1);
  }

  nextCommentId(): number {
    return (this.commentSeq += 1);
  }

  /**
   * Write a commit object with the viewer's identity and a trial-derived
   * timestamp, and return its sha. The caller moves the ref.
   */
  commit(repo: RepoRec, tree: string, parents: string[], message: string): string {
    const stamp = `${VIEWER.name} <${VIEWER.email}> ${this.nowUnix()} +0000`;
    const lines = [`tree ${tree}`, ...parents.map((parent) => `parent ${parent}`), `author ${stamp}`, `committer ${stamp}`];
    const data = Buffer.from(`${lines.join('\n')}\n\n${message}`, 'utf8');
    return putObject(repo, 'commit', data);
  }

  /** The commit sha a branch name points at, or null when the branch is unborn/absent. */
  branchTip(repo: RepoRec, branch: string): string | null {
    return repo.refs.get(`refs/heads/${branch}`) ?? null;
  }

  /** All commit shas reachable from a tip, newest first (parents before children never repeats). */
  history(repo: RepoRec, tip: string): string[] {
    const order: string[] = [];
    const seen = new Set<string>();
    const queue = [tip];
    while (queue.length > 0) {
      const sha = queue.shift() as string;
      if (seen.has(sha)) continue;
      seen.add(sha);
      const object = getObject(repo, sha);
      if (object === null || object.type !== 'commit') continue;
      order.push(sha);
      for (const parent of parseCommit(object.data).parents) queue.push(parent);
    }
    return order;
  }

  /** True when `ancestor` is reachable from `descendant` (the fast-forward test). */
  isAncestor(repo: RepoRec, ancestor: string, descendant: string): boolean {
    if (ancestor === descendant) return true;
    const seen = new Set<string>();
    const queue = [descendant];
    while (queue.length > 0) {
      const sha = queue.shift() as string;
      if (sha === ancestor) return true;
      if (seen.has(sha)) continue;
      seen.add(sha);
      const object = getObject(repo, sha);
      if (object === null || object.type !== 'commit') continue;
      for (const parent of parseCommit(object.data).parents) queue.push(parent);
    }
    return false;
  }

  /** The best common ancestor of two commits, or null when they share no history. */
  mergeBase(repo: RepoRec, a: string, b: string): string | null {
    const ancestorsOfA = new Set(this.history(repo, a));
    for (const sha of this.history(repo, b)) {
      if (ancestorsOfA.has(sha)) return sha;
    }
    return null;
  }
}

/** The process-wide store: one per server, created fresh at boot. */
export const store = new Store();
