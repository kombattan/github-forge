// GraphQL v4: a small but real executor for the documents gh and
// github-mcp-server send — viewer, repository reads, issue and pull-request
// connections with cursor paging, the create/close/merge mutations,
// Relay's node(id:), and the __type feature probes. Unknown fields are a
// 200 with an errors array naming them; an unknown repository is
// data.repository = null with no errors. Node ids are the same strings the
// REST surface returns as node_id, so an id read anywhere works everywhere.

import { store, VIEWER, type IssueRec, type PullRec, type RepoRec } from './store.ts';
import { performSquashMerge, pullFiles, pullHasConflict, refreshPull } from './rest.ts';
import { sendJson, type Ctx } from './http.ts';

// ---------------------------------------------------------------------------
// Node ids: base64 of "<prefix>:<Type><numeric id>", GitHub's legacy form.
// ---------------------------------------------------------------------------

const NODE_PREFIX: Record<string, string> = {
  User: '04',
  Repository: '010',
  Issue: '05',
  PullRequest: '09',
  IssueComment: '012',
  Label: '06',
  Ref: '08',
  Commit: '03',
};

/** Encode a node id exactly as the REST surface's node_id fields do. */
export function nodeId(type: string, numericId: number): string {
  return Buffer.from(`${NODE_PREFIX[type] ?? '00'}:${type}${numericId}`).toString('base64');
}

/** Decode a node id back to its type and numeric id, or null. */
export function decodeNodeId(id: string): { type: string; numericId: number } | null {
  try {
    const text = Buffer.from(id, 'base64').toString('utf8');
    const match = /^\d+:([A-Za-z]+)(\d+)$/.exec(text);
    if (match === null) return null;
    return { type: match[1] as string, numericId: Number(match[2]) };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Lexer and parser for the GraphQL subset the clients use.
// ---------------------------------------------------------------------------

type Token = { kind: 'name' | 'string' | 'number' | 'punct' | 'eof'; value: string };

function lex(source: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < source.length) {
    const ch = source[i] as string;
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === ',') {
      i += 1;
      continue;
    }
    if (ch === '#') {
      while (i < source.length && source[i] !== '\n') i += 1;
      continue;
    }
    if ('{}()[]:!$=@.'.includes(ch)) {
      if (ch === '.' && source.slice(i, i + 3) === '...') {
        tokens.push({ kind: 'punct', value: '...' });
        i += 3;
      } else {
        tokens.push({ kind: 'punct', value: ch });
        i += 1;
      }
      continue;
    }
    if (ch === '"') {
      if (source.slice(i, i + 3) === '"""') {
        const end = source.indexOf('"""', i + 3);
        tokens.push({ kind: 'string', value: source.slice(i + 3, end === -1 ? source.length : end) });
        i = end === -1 ? source.length : end + 3;
        continue;
      }
      let value = '';
      i += 1;
      while (i < source.length && source[i] !== '"') {
        if (source[i] === '\\' && i + 1 < source.length) {
          const esc = source[i + 1] as string;
          value += esc === 'n' ? '\n' : esc === 't' ? '\t' : esc === 'r' ? '\r' : esc;
          i += 2;
        } else {
          value += source[i];
          i += 1;
        }
      }
      i += 1;
      tokens.push({ kind: 'string', value });
      continue;
    }
    if (/[0-9-]/.test(ch)) {
      let value = '';
      while (i < source.length && /[0-9.eE+-]/.test(source[i] as string)) {
        value += source[i];
        i += 1;
      }
      tokens.push({ kind: 'number', value });
      continue;
    }
    if (/[_A-Za-z]/.test(ch)) {
      let value = '';
      while (i < source.length && /[_0-9A-Za-z]/.test(source[i] as string)) {
        value += source[i];
        i += 1;
      }
      tokens.push({ kind: 'name', value });
      continue;
    }
    throw new Error(`unexpected character ${JSON.stringify(ch)} in GraphQL document`);
  }
  tokens.push({ kind: 'eof', value: '' });
  return tokens;
}

export type GqlValue =
  | { kind: 'string'; value: string }
  | { kind: 'number'; value: number }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'null' }
  | { kind: 'enum'; value: string }
  | { kind: 'variable'; name: string }
  | { kind: 'list'; items: GqlValue[] }
  | { kind: 'object'; fields: Record<string, GqlValue> };

export interface GqlField {
  kind: 'field';
  alias: string | null;
  name: string;
  args: Record<string, GqlValue>;
  selectionSet: GqlSelection[] | null;
}

export type GqlSelection =
  | GqlField
  | { kind: 'inline'; typeCondition: string | null; selectionSet: GqlSelection[] }
  | { kind: 'spread'; name: string };

export interface GqlOperation {
  type: 'query' | 'mutation';
  name: string | null;
  selectionSet: GqlSelection[];
}

export interface GqlDocument {
  operations: GqlOperation[];
  fragments: Map<string, { typeCondition: string; selectionSet: GqlSelection[] }>;
}

class Parser {
  private pos = 0;
  private readonly tokens: Token[];

  constructor(tokens: Token[]) {
    this.tokens = tokens;
  }

  private peek(): Token {
    return this.tokens[this.pos] as Token;
  }

  private next(): Token {
    const token = this.tokens[this.pos] as Token;
    this.pos += 1;
    return token;
  }

  private expect(value: string): void {
    const token = this.next();
    if (token.value !== value) throw new Error(`expected ${value}, found ${token.value}`);
  }

  private at(value: string): boolean {
    return this.peek().value === value;
  }

  parseDocument(): GqlDocument {
    const operations: GqlOperation[] = [];
    const fragments = new Map<string, { typeCondition: string; selectionSet: GqlSelection[] }>();
    while (this.peek().kind !== 'eof') {
      if (this.at('{')) {
        operations.push({ type: 'query', name: null, selectionSet: this.parseSelectionSet() });
        continue;
      }
      const keyword = this.next();
      if (keyword.value === 'query' || keyword.value === 'mutation') {
        let name: string | null = null;
        if (this.peek().kind === 'name') name = this.next().value;
        if (this.at('(')) this.skipBalanced('(', ')');
        // Directives after the variable definitions, if any.
        while (this.at('@')) {
          this.next();
          this.next();
          if (this.at('(')) this.skipBalanced('(', ')');
        }
        operations.push({ type: keyword.value, name, selectionSet: this.parseSelectionSet() });
        continue;
      }
      if (keyword.value === 'fragment') {
        const fragName = this.next().value;
        this.expect('on');
        const typeCondition = this.next().value;
        fragments.set(fragName, { typeCondition, selectionSet: this.parseSelectionSet() });
        continue;
      }
      throw new Error(`unexpected token ${keyword.value} in GraphQL document`);
    }
    return { operations, fragments };
  }

  private skipBalanced(open: string, close: string): void {
    let depth = 0;
    do {
      const token = this.next();
      if (token.value === open) depth += 1;
      else if (token.value === close) depth -= 1;
      if (token.kind === 'eof') break;
    } while (depth > 0);
  }

  private parseSelectionSet(): GqlSelection[] {
    this.expect('{');
    const selections: GqlSelection[] = [];
    while (!this.at('}')) {
      if (this.at('...')) {
        this.next();
        if (this.peek().kind === 'name' && this.peek().value !== 'on') {
          selections.push({ kind: 'spread', name: this.next().value });
        } else {
          let typeCondition: string | null = null;
          if (this.at('on')) {
            this.next();
            typeCondition = this.next().value;
          }
          selections.push({ kind: 'inline', typeCondition, selectionSet: this.parseSelectionSet() });
        }
        continue;
      }
      const first = this.next();
      let alias: string | null = null;
      let name = first.value;
      if (this.at(':')) {
        this.next();
        alias = name;
        name = this.next().value;
      }
      const args: Record<string, GqlValue> = {};
      if (this.at('(')) {
        this.next();
        while (!this.at(')')) {
          const argName = this.next().value;
          this.expect(':');
          args[argName] = this.parseValue();
        }
        this.next();
      }
      while (this.at('@')) {
        this.next();
        this.next();
        if (this.at('(')) this.skipBalanced('(', ')');
      }
      const selectionSet = this.at('{') ? this.parseSelectionSet() : null;
      selections.push({ kind: 'field', alias, name, args, selectionSet });
    }
    this.next();
    return selections;
  }

  private parseValue(): GqlValue {
    const token = this.next();
    if (token.kind === 'string') return { kind: 'string', value: token.value };
    if (token.kind === 'number') return { kind: 'number', value: Number(token.value) };
    if (token.value === '$') {
      const name = this.next().value;
      return { kind: 'variable', name };
    }
    if (token.value === '[') {
      const items: GqlValue[] = [];
      while (!this.at(']')) items.push(this.parseValue());
      this.next();
      return { kind: 'list', items };
    }
    if (token.value === '{') {
      const fields: Record<string, GqlValue> = {};
      while (!this.at('}')) {
        const key = this.next().value;
        this.expect(':');
        fields[key] = this.parseValue();
      }
      this.next();
      return { kind: 'object', fields };
    }
    if (token.kind === 'name') {
      if (token.value === 'true') return { kind: 'boolean', value: true };
      if (token.value === 'false') return { kind: 'boolean', value: false };
      if (token.value === 'null') return { kind: 'null' };
      return { kind: 'enum', value: token.value };
    }
    throw new Error(`unexpected value token ${token.value}`);
  }
}

/** Evaluate a parsed value against the operation's variables. */
function evalValue(value: GqlValue, variables: Record<string, unknown>): unknown {
  switch (value.kind) {
    case 'string':
    case 'number':
    case 'boolean':
      return value.value;
    case 'null':
      return null;
    case 'enum':
      return value.value;
    case 'variable':
      return variables[value.name];
    case 'list':
      return value.items.map((item) => evalValue(item, variables));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const [key, inner] of Object.entries(value.fields)) out[key] = evalValue(inner, variables);
      return out;
    }
  }
}

// ---------------------------------------------------------------------------
// Schema: the type/field table introspection reports, and node wrappers.
// ---------------------------------------------------------------------------

const TYPE_FIELDS: Record<string, string[]> = {
  Query: ['viewer', 'repository', 'node', 'nodes', 'user', 'organization', 'search', 'rateLimit'],
  Mutation: ['createIssue', 'closeIssue', 'reopenIssue', 'createPullRequest', 'mergePullRequest', 'addComment', 'updateIssue', 'createRepository'],
  User: ['id', 'databaseId', 'login', 'name', 'email', 'url', 'avatarUrl', 'createdAt', 'updatedAt', 'isViewer'],
  Repository: [
    'id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled',
    'issue', 'issues', 'pullRequest', 'pullRequests', 'description', 'isPrivate', 'createdAt', 'updatedAt', 'url',
    'stargazerCount', 'forkCount', 'labels', 'refs', 'assignableUsers', 'mentionableUsers',
  ],
  Issue: [
    'id', 'databaseId', 'number', 'title', 'state', 'body', 'bodyText', 'url', 'createdAt', 'updatedAt', 'closed',
    'closedAt', 'author', 'repository', 'labels', 'comments', 'assignees', 'milestone',
  ],
  PullRequest: [
    'id', 'databaseId', 'number', 'title', 'body', 'state', 'merged', 'mergedAt', 'mergeable', 'headRefName',
    'baseRefName', 'headRef', 'baseRef', 'files', 'commits', 'comments', 'author', 'repository', 'createdAt',
    'updatedAt', 'closed', 'closedAt', 'additions', 'deletions', 'changedFiles', 'mergeCommit', 'url', 'isDraft',
  ],
  IssueComment: ['id', 'databaseId', 'body', 'createdAt', 'updatedAt', 'author', 'url'],
  Label: ['id', 'name', 'color', 'description', 'url'],
  Ref: ['id', 'name', 'prefix', 'target'],
  Commit: ['id', 'oid', 'message', 'messageHeadline', 'committedDate', 'authoredDate', 'author', 'parents'],
  GitActor: ['name', 'email', 'date'],
  PageInfo: ['hasNextPage', 'hasPreviousPage', 'startCursor', 'endCursor'],
  ChangedFile: ['path', 'additions', 'deletions', 'changeType'],
  __Type: ['name', 'kind', 'description', 'fields', 'enumValues', 'possibleTypes', 'inputFields', 'ofType'],
  __Field: ['name', 'description', 'args', 'type', 'isDeprecated', 'deprecationReason'],
  __EnumValue: ['name', 'description', 'isDeprecated', 'deprecationReason'],
  __Schema: ['types', 'queryType', 'mutationType', 'directives'],
};

const ENUM_VALUES: Record<string, string[]> = {
  SearchType: ['ISSUE', 'PULL_REQUEST', 'REPOSITORY', 'USER', 'DISCUSSION', 'CODE', 'COMMIT', 'LABEL', 'MARKETPLACE', 'ORGANIZATION', 'PROJECT', 'TOPIC', 'WIKI'],
  IssueState: ['OPEN', 'CLOSED'],
  PullRequestState: ['OPEN', 'CLOSED', 'MERGED'],
  MergeableState: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'],
  IssueOrderField: ['CREATED_AT', 'UPDATED_AT', 'COMMENTS'],
  OrderDirection: ['ASC', 'DESC'],
  RepositoryPrivacy: ['PUBLIC', 'PRIVATE'],
  FileChangeType: ['ADDED', 'MODIFIED', 'DELETED', 'RENAMED', 'COPIED', 'CHANGED'],
};

/** A resolved object: a typename plus whatever the field resolvers read. */
type GNode = { __typename: string } & Record<string, unknown>;

const userNode = (): GNode => ({ __typename: 'User' });
const repoNode = (repo: RepoRec): GNode => ({ __typename: 'Repository', repo });
const issueNode = (repo: RepoRec, issue: IssueRec): GNode => ({ __typename: 'Issue', repo, issue });
const pullNode = (repo: RepoRec, pull: PullRec): GNode => ({ __typename: 'PullRequest', repo, pull: refreshPull(repo, pull) });

/** The cursor GitHub's array connections use: base64 of "arrayconnection:<index>". */
function cursorFor(index: number): string {
  return Buffer.from(`arrayconnection:${index}`).toString('base64');
}

/** Decode an `after` cursor to the index it points at, or -1. */
function cursorIndex(cursor: unknown): number {
  if (typeof cursor !== 'string' || cursor === '') return -1;
  try {
    const match = /^arrayconnection:(\d+)$/.exec(Buffer.from(cursor, 'base64').toString('utf8'));
    return match === null ? -1 : Number(match[1]);
  } catch {
    return -1;
  }
}

interface Page {
  slice: GNode[];
  totalCount: number;
  hasNextPage: boolean;
  hasPreviousPage: boolean;
  startCursor: string | null;
  endCursor: string | null;
  /** Absolute index of the first sliced item (for edge cursors). */
  startIndex: number;
}

/** Apply first/after paging to an already-ordered node list. */
function paginate(items: GNode[], args: Record<string, unknown>): Page {
  const start = cursorIndex(args.after) + 1;
  const first = typeof args.first === 'number' ? Math.max(0, args.first) : items.length;
  const slice = items.slice(start, start + first);
  return {
    slice,
    totalCount: items.length,
    hasNextPage: start + slice.length < items.length,
    hasPreviousPage: start > 0,
    startCursor: slice.length > 0 ? cursorFor(start) : null,
    endCursor: slice.length > 0 ? cursorFor(start + slice.length - 1) : null,
    startIndex: start,
  };
}

/** Wrap a page as a connection node the generic connection resolvers serve. */
function connection(typeName: string, page: Page): GNode {
  return {
    __typename: typeName,
    __connection: true,
    nodes: page.slice,
    totalCount: page.totalCount,
    pageInfo: {
      __typename: 'PageInfo',
      hasNextPage: page.hasNextPage,
      hasPreviousPage: page.hasPreviousPage,
      startCursor: page.startCursor,
      endCursor: page.endCursor,
    } as GNode,
    edges: page.slice.map((node, i) => ({
      __typename: `${typeName.replace(/Connection$/, '')}Edge`,
      __edge: true,
      node,
      cursor: cursorFor(page.startIndex + i),
    })),
  };
}

/** Issues of a repo in connection order: orderBy honored, ties by number. */
function orderedIssues(repo: RepoRec, args: Record<string, unknown>): IssueRec[] {
  let list = [...repo.issues.values()];
  const states = Array.isArray(args.states) ? (args.states as unknown[]).map((state) => String(state).toLowerCase()) : null;
  if (states !== null) list = list.filter((issue) => states.includes(issue.state));
  const orderBy = (args.orderBy ?? null) as { field?: string; direction?: string } | null;
  const direction = orderBy?.direction === 'ASC' ? 1 : -1;
  const field = orderBy?.field ?? 'CREATED_AT';
  list.sort((a, b) => {
    const byField = field === 'UPDATED_AT' ? a.updatedAt.localeCompare(b.updatedAt) : a.number - b.number;
    return (byField !== 0 ? byField : a.number - b.number) * direction;
  });
  return list;
}

/** Pull requests of a repo in connection order (newest first by default). */
function orderedPulls(repo: RepoRec, args: Record<string, unknown>): PullRec[] {
  let list = [...repo.pulls.values()];
  const states = Array.isArray(args.states) ? (args.states as unknown[]).map((state) => String(state)) : null;
  if (states !== null) {
    list = list.filter((pull) => {
      const gqlState = pull.merged ? 'MERGED' : pull.state.toUpperCase();
      return states.includes(gqlState);
    });
  }
  const orderBy = (args.orderBy ?? null) as { direction?: string } | null;
  const direction = orderBy?.direction === 'ASC' ? 1 : -1;
  list.sort((a, b) => (a.number - b.number) * direction);
  return list;
}

/** Find a repository by its numeric (database) id. */
function repoById(numericId: number): RepoRec | null {
  return store.listRepos().find((repo) => repo.id === numericId) ?? null;
}

/** Find an issue anywhere by its numeric (database) id. */
function issueById(numericId: number): { repo: RepoRec; issue: IssueRec } | null {
  for (const repo of store.listRepos()) {
    for (const issue of repo.issues.values()) {
      if (issue.id === numericId) return { repo, issue };
    }
  }
  return null;
}

/** Find a pull request anywhere by its numeric (database) id. */
function pullById(numericId: number): { repo: RepoRec; pull: PullRec } | null {
  for (const repo of store.listRepos()) {
    for (const pull of repo.pulls.values()) {
      if (pull.id === numericId) return { repo, pull };
    }
  }
  return null;
}

/** A resolver-level failure: the field becomes null and the message is reported. */
class GqlError extends Error {}

/** Resolve a repository argument that may be a node id or a database id. */
function repoFromIdArg(value: unknown): RepoRec | null {
  if (typeof value === 'number') return repoById(value);
  if (typeof value === 'string') {
    const decoded = decodeNodeId(value);
    if (decoded !== null && decoded.type === 'Repository') return repoById(decoded.numericId);
    const asNumber = Number(value);
    if (Number.isInteger(asNumber)) return repoById(asNumber);
  }
  return null;
}

// ---------------------------------------------------------------------------
// Field resolution. One switch per type; an unlisted field on a known type
// is the unknown-field error the suite checks for.
// ---------------------------------------------------------------------------

interface ExecCtx {
  doc: GqlDocument;
  variables: Record<string, unknown>;
  errors: { message: string; path: (string | number)[] }[];
}

function argsOf(field: GqlField, ctx: ExecCtx): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(field.args)) out[key] = evalValue(value, ctx.variables);
  return out;
}

function typeNode(name: string): GNode | null {
  if (TYPE_FIELDS[name] !== undefined) return { __typename: '__Type', name, kind: 'OBJECT' };
  if (ENUM_VALUES[name] !== undefined) return { __typename: '__Type', name, kind: 'ENUM' };
  return null;
}

/** Resolve one field on one source object; throws GqlError for bad fields. */
function resolveField(typeName: string, source: GNode | null, field: GqlField, ctx: ExecCtx): unknown {
  const args = argsOf(field, ctx);
  const name = field.name;

  if (name === '__typename') return typeName;

  switch (typeName) {
    case 'Query': {
      switch (name) {
        case 'viewer':
          return userNode();
        case 'repository': {
          const repo = store.getRepo(String(args.owner ?? ''), String(args.name ?? ''));
          return repo === null ? null : repoNode(repo);
        }
        case 'node': {
          const decoded = decodeNodeId(String(args.id ?? ''));
          if (decoded === null) return null;
          if (decoded.type === 'Repository') {
            const repo = repoById(decoded.numericId);
            return repo === null ? null : repoNode(repo);
          }
          if (decoded.type === 'Issue') {
            const found = issueById(decoded.numericId);
            return found === null ? null : issueNode(found.repo, found.issue);
          }
          if (decoded.type === 'PullRequest') {
            const found = pullById(decoded.numericId);
            return found === null ? null : pullNode(found.repo, found.pull);
          }
          if (decoded.type === 'User') return userNode();
          return null;
        }
        case '__type':
          return typeNode(String(args.name ?? ''));
        case '__schema':
          return { __typename: '__Schema' };
        case 'user':
          return String(args.login ?? '') === VIEWER.login ? userNode() : null;
        default:
          break;
      }
      break;
    }
    case 'Mutation': {
      switch (name) {
        case 'createIssue': {
          const input = (args.input ?? {}) as Record<string, unknown>;
          const repo = repoFromIdArg(input.repositoryId);
          if (repo === null) throw new GqlError('repository not found');
          const title = String(input.title ?? '');
          if (title === '') throw new GqlError('title is required');
          const now = store.nowIso();
          const issue: IssueRec = {
            id: store.nextIssueId(),
            number: repo.nextNumber++,
            title,
            body: typeof input.body === 'string' ? input.body : null,
            state: 'open',
            labels: [],
            comments: [],
            user: VIEWER.login,
            createdAt: now,
            updatedAt: now,
          };
          repo.issues.set(issue.number, issue);
          return { __typename: 'CreateIssuePayload', issue: issueNode(repo, issue) };
        }
        case 'closeIssue':
        case 'reopenIssue': {
          const input = (args.input ?? {}) as Record<string, unknown>;
          const decoded = decodeNodeId(String(input.issueId ?? ''));
          const found = decoded !== null && decoded.type === 'Issue' ? issueById(decoded.numericId) : null;
          if (found === null) throw new GqlError('issue not found');
          found.issue.state = name === 'closeIssue' ? 'closed' : 'open';
          found.issue.updatedAt = store.nowIso();
          return { __typename: name === 'closeIssue' ? 'CloseIssuePayload' : 'ReopenIssuePayload', issue: issueNode(found.repo, found.issue) };
        }
        case 'createPullRequest': {
          const input = (args.input ?? {}) as Record<string, unknown>;
          const repo = repoFromIdArg(input.repositoryId);
          if (repo === null) throw new GqlError('repository not found');
          const head = String(input.headRefName ?? '');
          const base = String(input.baseRefName ?? '');
          const headSha = store.branchTip(repo, head);
          const baseSha = store.branchTip(repo, base);
          if (headSha === null || baseSha === null) throw new GqlError('head or base branch does not exist');
          const now = store.nowIso();
          const pull: PullRec = {
            id: store.nextIssueId(),
            number: repo.nextNumber++,
            title: String(input.title ?? ''),
            body: typeof input.body === 'string' ? input.body : null,
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
          return { __typename: 'CreatePullRequestPayload', pullRequest: pullNode(repo, pull) };
        }
        case 'mergePullRequest': {
          const input = (args.input ?? {}) as Record<string, unknown>;
          const decoded = decodeNodeId(String(input.pullRequestId ?? ''));
          const found = decoded !== null && decoded.type === 'PullRequest' ? pullById(decoded.numericId) : null;
          if (found === null) throw new GqlError('pull request not found');
          const sha = performSquashMerge(found.repo, found.pull);
          if (sha === null) throw new GqlError('Pull Request is not mergeable');
          return { __typename: 'MergePullRequestPayload', pullRequest: pullNode(found.repo, found.pull) };
        }
        case 'addComment': {
          const input = (args.input ?? {}) as Record<string, unknown>;
          const decoded = decodeNodeId(String(input.subjectId ?? ''));
          if (decoded === null) throw new GqlError('subject not found');
          const body = String(input.body ?? '');
          const now = store.nowIso();
          if (decoded.type === 'Issue') {
            const found = issueById(decoded.numericId);
            if (found === null) throw new GqlError('subject not found');
            const comment = { id: store.nextCommentId(), body, user: VIEWER.login, createdAt: now, updatedAt: now };
            found.issue.comments.push(comment);
            const node: GNode = { __typename: 'IssueComment', repo: found.repo, comment };
            return { __typename: 'AddCommentPayload', commentEdge: { __typename: 'IssueCommentEdge', __edge: true, node, cursor: '' } };
          }
          if (decoded.type === 'PullRequest') {
            const found = pullById(decoded.numericId);
            if (found === null) throw new GqlError('subject not found');
            const comment = { id: store.nextCommentId(), body, user: VIEWER.login, createdAt: now, updatedAt: now };
            found.pull.comments.push(comment);
            const node: GNode = { __typename: 'IssueComment', repo: found.repo, comment };
            return { __typename: 'AddCommentPayload', commentEdge: { __typename: 'IssueCommentEdge', __edge: true, node, cursor: '' } };
          }
          throw new GqlError('subject not found');
        }
        default:
          break;
      }
      break;
    }
    case 'User': {
      switch (name) {
        case 'id': return nodeId('User', VIEWER.id);
        case 'databaseId': return VIEWER.id;
        case 'login': return VIEWER.login;
        case 'name': return VIEWER.name;
        case 'email': return VIEWER.email;
        case 'url': return '';
        case 'avatarUrl': return '';
        case 'isViewer': return true;
        default: break;
      }
      break;
    }
    case 'Repository': {
      const repo = source?.repo as RepoRec;
      switch (name) {
        case 'id': return nodeId('Repository', repo.id);
        case 'databaseId': return repo.id;
        case 'name': return repo.name;
        case 'nameWithOwner': return `${repo.owner}/${repo.name}`;
        case 'owner': return userNode();
        case 'description': return repo.description;
        case 'isPrivate': return repo.isPrivate;
        case 'viewerPermission': return 'ADMIN';
        case 'hasIssuesEnabled': return true;
        case 'createdAt': return repo.createdAt;
        case 'updatedAt': return repo.updatedAt;
        case 'url': return '';
        case 'stargazerCount': return 0;
        case 'forkCount': return 0;
        case 'defaultBranchRef': {
          const tip = store.branchTip(repo, repo.defaultBranch);
          return tip === null ? null : { __typename: 'Ref', repo, branch: repo.defaultBranch, sha: tip };
        }
        case 'issue': {
          const issue = repo.issues.get(Number(args.number));
          return issue === undefined ? null : issueNode(repo, issue);
        }
        case 'issues': {
          const items = orderedIssues(repo, args).map((issue) => issueNode(repo, issue));
          return connection('IssueConnection', paginate(items, args));
        }
        case 'pullRequest': {
          const pull = repo.pulls.get(Number(args.number));
          return pull === undefined ? null : pullNode(repo, pull);
        }
        case 'pullRequests': {
          const items = orderedPulls(repo, args).map((pull) => pullNode(repo, pull));
          return connection('PullRequestConnection', paginate(items, args));
        }
        case 'labels': {
          const items = [...repo.labels.values()].map((label): GNode => ({ __typename: 'Label', repo, labelName: label.name }));
          return connection('LabelConnection', paginate(items, args));
        }
        default: break;
      }
      break;
    }
    case 'Issue': {
      const repo = source?.repo as RepoRec;
      const issue = source?.issue as IssueRec;
      switch (name) {
        case 'id': return nodeId('Issue', issue.id);
        case 'databaseId': return issue.id;
        case 'number': return issue.number;
        case 'title': return issue.title;
        case 'body': return issue.body ?? '';
        case 'bodyText': return issue.body ?? '';
        case 'state': return issue.state.toUpperCase();
        case 'closed': return issue.state === 'closed';
        case 'closedAt': return issue.state === 'closed' ? issue.updatedAt : null;
        case 'createdAt': return issue.createdAt;
        case 'updatedAt': return issue.updatedAt;
        case 'url': return '';
        case 'author': return userNode();
        case 'repository': return repoNode(repo);
        case 'labels': {
          const items = issue.labels.map((labelName): GNode => ({ __typename: 'Label', repo, labelName }));
          return connection('LabelConnection', paginate(items, args));
        }
        case 'comments': {
          const items = issue.comments.map((comment): GNode => ({ __typename: 'IssueComment', repo, comment }));
          return connection('IssueCommentConnection', paginate(items, args));
        }
        default: break;
      }
      break;
    }
    case 'PullRequest': {
      const repo = source?.repo as RepoRec;
      const pull = source?.pull as PullRec;
      switch (name) {
        case 'id': return nodeId('PullRequest', pull.id);
        case 'databaseId': return pull.id;
        case 'number': return pull.number;
        case 'title': return pull.title;
        case 'body': return pull.body ?? '';
        case 'state': return pull.merged ? 'MERGED' : pull.state.toUpperCase();
        case 'merged': return pull.merged;
        case 'mergedAt': return pull.merged ? pull.updatedAt : null;
        case 'closed': return pull.state === 'closed';
        case 'closedAt': return pull.state === 'closed' ? pull.updatedAt : null;
        case 'createdAt': return pull.createdAt;
        case 'updatedAt': return pull.updatedAt;
        case 'url': return '';
        case 'isDraft': return false;
        case 'author': return userNode();
        case 'repository': return repoNode(repo);
        case 'headRefName': return pull.headRef;
        case 'baseRefName': return pull.baseRef;
        case 'headRef': {
          const tip = store.branchTip(repo, pull.headRef);
          return tip === null ? null : { __typename: 'Ref', repo, branch: pull.headRef, sha: tip };
        }
        case 'baseRef': {
          const tip = store.branchTip(repo, pull.baseRef);
          return tip === null ? null : { __typename: 'Ref', repo, branch: pull.baseRef, sha: tip };
        }
        case 'mergeable': {
          if (pull.state !== 'open') return 'UNKNOWN';
          return pullHasConflict(repo, pull) ? 'CONFLICTING' : 'MERGEABLE';
        }
        case 'mergeCommit': {
          return pull.mergeCommitSha === null ? null : { __typename: 'Commit', repo, sha: pull.mergeCommitSha };
        }
        case 'files': {
          const items = pullFiles(repo, pull).map((file): GNode => ({
            __typename: 'ChangedFile',
            path: file.filename,
            additions: file.additions,
            deletions: file.deletions,
            changeType: file.status === 'added' ? 'ADDED' : file.status === 'removed' ? 'DELETED' : 'MODIFIED',
          }));
          return connection('ChangedFileConnection', paginate(items, args));
        }
        case 'additions': return pullFiles(repo, pull).reduce((sum, file) => sum + (file.additions as number), 0);
        case 'deletions': return pullFiles(repo, pull).reduce((sum, file) => sum + (file.deletions as number), 0);
        case 'changedFiles': return pullFiles(repo, pull).length;
        case 'comments': {
          const items = pull.comments.map((comment): GNode => ({ __typename: 'IssueComment', repo, comment }));
          return connection('IssueCommentConnection', paginate(items, args));
        }
        case 'commits': {
          const items = store.history(repo, pull.headSha).map((sha): GNode => ({ __typename: 'Commit', repo, sha }));
          return connection('PullRequestCommitConnection', paginate(items, args));
        }
        default: break;
      }
      break;
    }
    case 'IssueComment': {
      const comment = source?.comment as { id: number; body: string; createdAt: string; updatedAt: string };
      switch (name) {
        case 'id': return nodeId('IssueComment', comment.id);
        case 'databaseId': return comment.id;
        case 'body': return comment.body;
        case 'createdAt': return comment.createdAt;
        case 'updatedAt': return comment.updatedAt;
        case 'author': return userNode();
        case 'url': return '';
        default: break;
      }
      break;
    }
    case 'Label': {
      const repo = source?.repo as RepoRec;
      const labelName = source?.labelName as string;
      const label = repo.labels.get(labelName);
      switch (name) {
        case 'id': return Buffer.from(`06:Label${labelName}`).toString('base64');
        case 'name': return labelName;
        case 'color': return label?.color ?? 'ededed';
        case 'description': return label?.description ?? null;
        case 'url': return '';
        default: break;
      }
      break;
    }
    case 'Ref': {
      const repo = source?.repo as RepoRec;
      switch (name) {
        case 'id': return Buffer.from(`08:Ref${repo.id}:${String(source?.branch)}`).toString('base64');
        case 'name': return source?.branch as string;
        case 'prefix': return 'refs/heads/';
        case 'target': return { __typename: 'Commit', repo, sha: source?.sha as string };
        default: break;
      }
      break;
    }
    case 'Commit': {
      const repo = source?.repo as RepoRec;
      const sha = source?.sha as string;
      switch (name) {
        case 'id': return Buffer.from(`03:Commit${sha}`).toString('base64');
        case 'oid': return sha;
        case 'message': {
          const object = repo.objects.get(sha);
          return object === undefined ? '' : object.data.toString('utf8').split('\n\n').slice(1).join('\n\n');
        }
        case 'messageHeadline': {
          const object = repo.objects.get(sha);
          if (object === undefined) return '';
          const message = object.data.toString('utf8').split('\n\n').slice(1).join('\n\n');
          return message.split('\n')[0] ?? '';
        }
        case 'committedDate':
        case 'authoredDate':
          return repo.updatedAt;
        case 'author':
          return { __typename: 'GitActor', name: VIEWER.name, email: VIEWER.email, date: repo.updatedAt };
        default: break;
      }
      break;
    }
    case 'GitActor': {
      switch (name) {
        case 'name': return source?.name as string;
        case 'email': return source?.email as string;
        case 'date': return source?.date as string;
        default: break;
      }
      break;
    }
    case 'ChangedFile': {
      switch (name) {
        case 'path': return source?.path as string;
        case 'additions': return source?.additions as number;
        case 'deletions': return source?.deletions as number;
        case 'changeType': return source?.changeType as string;
        default: break;
      }
      break;
    }
    case 'PageInfo': {
      switch (name) {
        case 'hasNextPage': return source?.hasNextPage as boolean;
        case 'hasPreviousPage': return source?.hasPreviousPage as boolean;
        case 'startCursor': return (source?.startCursor as string | null) ?? null;
        case 'endCursor': return (source?.endCursor as string | null) ?? null;
        default: break;
      }
      break;
    }
    case '__Type': {
      const typeName = source?.name as string;
      switch (name) {
        case 'name': return typeName;
        case 'kind': return source?.kind as string;
        case 'description': return null;
        case 'fields': {
          const fields = TYPE_FIELDS[typeName] ?? [];
          return fields.map((fieldName): GNode => ({ __typename: '__Field', name: fieldName }));
        }
        case 'enumValues': {
          const values = ENUM_VALUES[typeName] ?? [];
          return values.map((valueName): GNode => ({ __typename: '__EnumValue', name: valueName }));
        }
        case 'possibleTypes': return [];
        case 'inputFields': return [];
        case 'ofType': return null;
        default: break;
      }
      break;
    }
    case '__Field': {
      if (name === 'name') return source?.name as string;
      if (name === 'description') return null;
      if (name === 'isDeprecated') return false;
      if (name === 'deprecationReason') return null;
      if (name === 'args') return [];
      if (name === 'type') return null;
      break;
    }
    case '__EnumValue': {
      if (name === 'name') return source?.name as string;
      if (name === 'description') return null;
      if (name === 'isDeprecated') return false;
      if (name === 'deprecationReason') return null;
      break;
    }
    case '__Schema': {
      if (name === 'queryType') return { __typename: '__Type', name: 'Query', kind: 'OBJECT' };
      if (name === 'mutationType') return { __typename: '__Type', name: 'Mutation', kind: 'OBJECT' };
      if (name === 'types') return [...Object.keys(TYPE_FIELDS), ...Object.keys(ENUM_VALUES)].map((typeName) => typeNode(typeName)).filter((node) => node !== null);
      if (name === 'directives') return [];
      break;
    }
    default:
      break;
  }

  // Payload types carry their one object under its own field name.
  if (typeName === 'CreateIssuePayload' || typeName === 'CloseIssuePayload' || typeName === 'ReopenIssuePayload') {
    if (name === 'issue') return source?.issue as GNode;
    if (name === 'clientMutationId') return null;
  }
  if (typeName === 'CreatePullRequestPayload' || typeName === 'MergePullRequestPayload') {
    if (name === 'pullRequest') return source?.pullRequest as GNode;
    if (name === 'clientMutationId') return null;
  }
  if (typeName === 'AddCommentPayload') {
    if (name === 'commentEdge') return source?.commentEdge as GNode;
    if (name === 'clientMutationId') return null;
  }
  // Connections and edges resolve generically from their stored shape.
  if (source?.__connection === true) {
    if (name === 'nodes') return source.nodes as GNode[];
    if (name === 'edges') return source.edges as GNode[];
    if (name === 'pageInfo') return source.pageInfo as GNode;
    if (name === 'totalCount') return source.totalCount as number;
  }
  if (source?.__edge === true) {
    if (name === 'node') return source.node as GNode;
    if (name === 'cursor') return source.cursor as string;
  }

  throw new GqlError(`Field '${name}' doesn't exist on type '${typeName}'`);
}

// ---------------------------------------------------------------------------
// Execution: walk selection sets, honoring aliases and fragments, collecting
// per-field errors instead of failing the whole operation.
// ---------------------------------------------------------------------------

function execSet(typeName: string, source: GNode | null, selections: GqlSelection[], ctx: ExecCtx, path: (string | number)[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const selection of selections) {
    if (selection.kind === 'inline') {
      if (selection.typeCondition === null || selection.typeCondition === typeName || selection.typeCondition === 'Node') {
        Object.assign(out, execSet(typeName, source, selection.selectionSet, ctx, path));
      }
      continue;
    }
    if (selection.kind === 'spread') {
      const fragment = ctx.doc.fragments.get(selection.name);
      if (fragment !== undefined && (fragment.typeCondition === typeName || fragment.typeCondition === 'Node')) {
        Object.assign(out, execSet(typeName, source, fragment.selectionSet, ctx, path));
      }
      continue;
    }
    const key = selection.alias ?? selection.name;
    try {
      const value = resolveField(typeName, source, selection, ctx);
      out[key] = complete(value, selection, ctx, [...path, key]);
    } catch (err) {
      out[key] = null;
      ctx.errors.push({ message: err instanceof Error ? err.message : String(err), path: [...path, key] });
    }
  }
  return out;
}

/** Finish a resolved value: recurse into objects and lists with selection sets. */
function complete(value: unknown, field: GqlField, ctx: ExecCtx, path: (string | number)[]): unknown {
  if (value === null || value === undefined) return null;
  if (Array.isArray(value)) return value.map((item, index) => complete(item, field, ctx, [...path, index]));
  if (typeof value === 'object') {
    const node = value as GNode;
    if (field.selectionSet === null) return node;
    return execSet(node.__typename, node, field.selectionSet, ctx, path);
  }
  return value;
}

/** Run one parsed operation; returns the {data, errors?} response object. */
function executeOperation(doc: GqlDocument, operation: GqlOperation, variables: Record<string, unknown>): Record<string, unknown> {
  const ctx: ExecCtx = { doc, variables, errors: [] };
  const rootType = operation.type === 'mutation' ? 'Mutation' : 'Query';
  const data = execSet(rootType, null, operation.selectionSet, ctx, []);
  const response: Record<string, unknown> = { data };
  if (ctx.errors.length > 0) response.errors = ctx.errors.map((error) => ({ message: error.message, path: error.path }));
  return response;
}

/** Run one request body ({query, variables, operationName}) end to end. */
function runOne(body: Record<string, unknown>): Record<string, unknown> {
  const query = typeof body.query === 'string' ? body.query : '';
  const variables = (body.variables !== null && typeof body.variables === 'object' ? body.variables : {}) as Record<string, unknown>;
  const operationName = typeof body.operationName === 'string' ? body.operationName : null;
  let doc: GqlDocument;
  try {
    doc = new Parser(lex(query)).parseDocument();
  } catch (err) {
    return { errors: [{ message: err instanceof Error ? err.message : 'parse error' }] };
  }
  const operation = operationName !== null ? doc.operations.find((op) => op.name === operationName) : doc.operations[0];
  if (operation === undefined) return { errors: [{ message: 'operation not found' }] };
  return executeOperation(doc, operation, variables);
}

/** Route one POST /api/graphql request: a single operation or a JSON batch. */
export async function handleGraphql(ctx: Ctx): Promise<void> {
  if (ctx.method !== 'POST') {
    sendJson(ctx, 404, { message: 'Not Found' });
    return;
  }
  if (ctx.jsonError) {
    sendJson(ctx, 400, { errors: [{ message: 'Invalid JSON in request body' }] });
    return;
  }
  if (Array.isArray(ctx.jsonRaw)) {
    const results = ctx.jsonRaw.map((entry) => runOne((entry ?? {}) as Record<string, unknown>));
    sendJson(ctx, 200, results);
    return;
  }
  sendJson(ctx, 200, runOne(ctx.json ?? {}));
}
