// Git smart HTTP: the advertisement, ls-refs and fetch of upload-pack
// (protocol v2, with a v0 fallback) and the v0 receive-pack, all served
// from the repository's own object store — no git binary anywhere. The
// dialect follows the suite's client exactly: v2 answers in sections, v0
// fetch answers shallow lines, one ACK or NAK, then the sideband-framed
// pack; pushes are fast-forward only and report per ref.

import {
  getObject,
  parseCommit,
  parseTree,
  store,
  type GitObject,
  type RepoRec,
} from './store.ts';
import { sendBytes, sendError, type Ctx } from './http.ts';
import { buildPack, parseAllPackets, parsePack, parsePackets, pktDelim, pktFlush, pktLine, writePktLength, ZERO_SHA, type Packet } from './pack.ts';

const AGENT = 'forge/1.0';
const UPLOAD_CAPS_V0 = 'side-band-64k shallow ofs-delta allow-tip-sha1-in-want';
const RECEIVE_CAPS = 'report-status delete-refs side-band-64k ofs-delta';

/** The commit sha HEAD names (the default branch tip), or the zero sha. */
function headSha(repo: RepoRec): string {
  return store.branchTip(repo, repo.defaultBranch) ?? ZERO_SHA;
}

/**
 * Peel results memoize by sha: objects are content-addressed and
 * immutable, so a sha's peel is the same in every repository and at every
 * moment — except a peel that ran into a missing object, whose answer can
 * change when the object arrives; those are never cached.
 */
const peelCache = new Map<string, { sha: string; type: string }>();
const PEEL_CACHE_MAX = 1024;

/** Peel a tag object chain down to the object it ultimately names. */
function peel(repo: RepoRec, sha: string): { sha: string; type: string } {
  const cached = peelCache.get(sha);
  if (cached !== undefined) return cached;
  let current = sha;
  let result: { sha: string; type: string } | null = null;
  for (let guard = 0; guard < 16; guard += 1) {
    const object = getObject(repo, current);
    if (object === null) return { sha: current, type: 'unknown' };
    if (object.type !== 'tag') {
      result = { sha: current, type: object.type };
      break;
    }
    const match = /^object ([0-9a-f]{40})$/m.exec(object.data.toString('utf8'));
    if (match === null) {
      result = { sha: current, type: 'tag' };
      break;
    }
    current = match[1] as string;
  }
  if (result === null) result = { sha: current, type: 'tag' };
  if (peelCache.size >= PEEL_CACHE_MAX) {
    const oldest = peelCache.keys().next().value;
    if (oldest !== undefined) peelCache.delete(oldest);
  }
  peelCache.set(sha, result);
  return result;
}

/** Committer timestamps memoize by commit buffer identity (see store.ts). */
const commitTimeCache = new WeakMap<Buffer, number>();

/** The committer timestamp (unix seconds) of a commit, or 0. */
function commitTime(repo: RepoRec, sha: string): number {
  const object = getObject(repo, sha);
  if (object === null || object.type !== 'commit') return 0;
  const cached = commitTimeCache.get(object.data);
  if (cached !== undefined) return cached;
  const line = parseCommit(object.data).committerLine;
  const match = / (\d+) [+-]\d{4}$/.exec(line);
  const value = match === null ? 0 : Number(match[1]);
  commitTimeCache.set(object.data, value);
  return value;
}

/**
 * All objects reachable from a set of commits: the "already known" closure.
 * Returns true when the walk met a sha the store does not hold — the plan
 * cache needs to know, because such a walk's answer can change when the
 * missing object later arrives.
 */
function fullClosure(repo: RepoRec, tips: string[], into: Set<string>, stopAt?: Set<string>): boolean {
  let hitAbsent = false;
  const stack = [...tips];
  while (stack.length > 0) {
    const sha = stack.pop() as string;
    if (into.has(sha)) continue;
    const object = getObject(repo, sha);
    if (object === null) {
      hitAbsent = true;
      continue;
    }
    into.add(sha);
    if (object.type === 'commit') {
      const info = parseCommit(object.data);
      stack.push(info.tree);
      // A commit the client holds only as a shallow boundary is known
      // itself, but its ancestry is exactly what it does not have.
      if (stopAt === undefined || !stopAt.has(sha)) stack.push(...info.parents);
    } else if (object.type === 'tree') {
      for (const entry of parseTree(object.data)) stack.push(entry.sha);
    } else if (object.type === 'tag') {
      const target = peel(repo, sha);
      stack.push(target.sha);
    }
  }
  return hitAbsent;
}

interface Filter {
  kind: 'none' | 'blob-none' | 'blob-limit' | 'tree-depth';
  limit: number;
}

/** Parse a partial-clone filter spec ("blob:none", "blob:limit=1k", "tree:2"). */
function parseFilter(spec: string | null): Filter | null {
  if (spec === null) return null;
  if (spec === 'blob:none') return { kind: 'blob-none', limit: 0 };
  const blobLimit = /^blob:limit=(\d+)([kmg])?$/.exec(spec);
  if (blobLimit !== null) {
    const mult = blobLimit[2] === 'k' ? 1024 : blobLimit[2] === 'm' ? 1024 ** 2 : blobLimit[2] === 'g' ? 1024 ** 3 : 1;
    return { kind: 'blob-limit', limit: Number(blobLimit[1]) * mult };
  }
  const treeDepth = /^tree:(\d+)$/.exec(spec);
  if (treeDepth !== null) return { kind: 'tree-depth', limit: Number(treeDepth[1]) };
  return null;
}

/** Whether an object passes the fetch filter at a given tree depth. */
function passesFilter(object: GitObject, filter: Filter | null, treeDepth: number): boolean {
  if (filter === null) return true;
  if (filter.kind === 'blob-none') return object.type !== 'blob';
  if (filter.kind === 'blob-limit') return object.type !== 'blob' || object.data.length <= filter.limit;
  if (filter.kind === 'tree-depth') return object.type !== 'tree' || treeDepth <= filter.limit;
  return true;
}

interface FetchRequest {
  wants: string[];
  wantRefs: string[];
  haves: string[];
  clientShallow: string[];
  depth: number | null;
  deepenSince: number | null;
  deepenNot: string[];
  filter: Filter | null;
  done: boolean;
}

interface FetchPlan {
  objects: GitObject[];
  /** The included objects' shas, in pack order: the pack cache key. */
  key: string;
  shallow: string[];
  unshallow: string[];
  common: string[];
}

/**
 * Fetch plans memoize per repository when the request is a pure function
 * of the object store's immutable contents: every want, have and shallow
 * sha it names exists, it carries no deepen-not (the one input resolved
 * through the mutable refs), and the walk below met no missing object —
 * a walk that skipped over an absent object could plan differently once
 * that object arrives, so such plans are computed fresh every time.
 */
const planCache = new WeakMap<RepoRec, Map<string, FetchPlan>>();
const PLAN_CACHE_MAX = 64;

/** The memo key for a fetch request, or null when it may not be memoized. */
function planCacheKey(repo: RepoRec, request: FetchRequest): string | null {
  if (request.deepenNot.length > 0) return null;
  for (const sha of request.wants) if (!repo.objects.has(sha)) return null;
  for (const sha of request.haves) if (!repo.objects.has(sha)) return null;
  for (const sha of request.clientShallow) if (!repo.objects.has(sha)) return null;
  const filter = request.filter === null ? '' : `${request.filter.kind}:${request.filter.limit}`;
  return [
    request.wants.join(' '),
    request.haves.join(' '),
    request.clientShallow.join(' '),
    request.depth ?? '',
    request.deepenSince ?? '',
    filter,
  ].join('|');
}

/** Work out exactly which objects a fetch sends, and its shallow boundary. */
function planFetch(repo: RepoRec, request: FetchRequest): FetchPlan {
  const cacheKey = planCacheKey(repo, request);
  if (cacheKey !== null) {
    const cached = planCache.get(repo)?.get(cacheKey);
    if (cached !== undefined) return cached;
  }
  const plan = computePlan(repo, request);
  if (cacheKey !== null && !plan.hitAbsent) {
    let perRepo = planCache.get(repo);
    if (perRepo === undefined) {
      perRepo = new Map();
      planCache.set(repo, perRepo);
    }
    if (perRepo.size >= PLAN_CACHE_MAX) {
      const oldest = perRepo.keys().next().value;
      if (oldest !== undefined) perRepo.delete(oldest);
    }
    perRepo.set(cacheKey, plan);
  }
  return plan;
}

/** The plan walk itself, behind planFetch's memo. */
function computePlan(repo: RepoRec, request: FetchRequest): FetchPlan & { hitAbsent: boolean } {
  let hitAbsent = false;
  const shallowSet = new Set(request.clientShallow);
  const known = new Set<string>();
  if (fullClosure(repo, request.haves, known, shallowSet)) hitAbsent = true;
  for (const ref of request.deepenNot) {
    const tip = store.branchTip(repo, ref.replace(/^refs\/heads\//, '')) ?? repo.refs.get(ref);
    if (tip !== undefined) fullClosure(repo, [tip], known);
  }
  // The client's shallow boundary needs no exclusion of its own: the
  // depth limit below already keeps ancestry past the boundary out, and
  // when a deepen reaches past a boundary commit, that commit's parents
  // are exactly what must be sent (and the commit reported unshallowed).

  const included = new Map<string, GitObject>();
  const includedCommits = new Set<string>();
  const boundary = new Set<string>();
  const includeObject = (sha: string): void => {
    if (included.has(sha) || known.has(sha)) return;
    const object = getObject(repo, sha);
    if (object === null) {
      hitAbsent = true;
      return;
    }
    included.set(sha, object);
  };
  const includeTree = (treeSha: string, depth: number): void => {
    // A tree already in the pack needs no second walk — its entries were
    // included with it — unless the filter is a tree-depth one: there the
    // same tree can sit at different depths in different commits, and a
    // later, shallower visit can include what a deeper one cut off, so
    // those walks repeat exactly as an unmemoized walk would.
    if (known.has(treeSha)) return;
    if (included.has(treeSha) && request.filter?.kind !== 'tree-depth') return;
    const object = getObject(repo, treeSha);
    if (object === null) {
      hitAbsent = true;
      return;
    }
    if (!passesFilter(object, request.filter, depth)) return;
    included.set(treeSha, object);
    for (const entry of parseTree(object.data)) {
      if (entry.mode === '40000') {
        includeTree(entry.sha, depth + 1);
      } else if (!included.has(entry.sha) && !known.has(entry.sha)) {
        const blob = getObject(repo, entry.sha);
        if (blob === null) {
          hitAbsent = true;
        } else if (passesFilter(blob, request.filter, depth)) {
          included.set(entry.sha, blob);
        }
      }
    }
  };

  // Breadth-first over commits so depth counts generations from the wants.
  // The walk goes through commits the client already has — a shallow
  // boundary named as a have is the classic case — leaving known objects
  // out of the pack but still reaching the generations below them, which
  // is exactly what a deepen asks for. Two parallel arrays, not an object
  // per commit: a long history enqueues every ancestor.
  const queueShas: string[] = [];
  const queueGens: number[] = [];
  const seen = new Set<string>();
  for (const want of request.wants) {
    const object = getObject(repo, want);
    if (object === null) {
      hitAbsent = true;
      continue;
    }
    if (object.type === 'commit') {
      queueShas.push(want);
      queueGens.push(0);
    } else if (object.type === 'tree') includeTree(want, 0);
    else includeObject(want);
  }
  // An index cursor, not shift(): the walk is breadth-first either way and
  // a long history must not pay a memmove per commit.
  for (let head = 0; head < queueShas.length; head += 1) {
    const sha = queueShas[head] as string;
    const generation = queueGens[head] as number;
    if (seen.has(sha)) continue;
    seen.add(sha);
    const object = getObject(repo, sha);
    if (object === null || object.type !== 'commit') continue;
    const info = parseCommit(object.data);
    const withinSince = request.deepenSince === null || commitTime(repo, sha) >= request.deepenSince;
    const isIncluded = !known.has(sha) && withinSince;
    if (isIncluded) {
      includedCommits.add(sha);
      includeObject(sha);
      includeTree(info.tree, 0);
    }
    for (const parent of info.parents) {
      if (getObject(repo, parent) === null) {
        hitAbsent = true;
        continue;
      }
      const parentWithinDepth = request.depth === null || generation + 1 < request.depth;
      const parentWithinSince = request.deepenSince === null || commitTime(repo, parent) >= request.deepenSince;
      if (parentWithinDepth && parentWithinSince) {
        queueShas.push(parent);
        queueGens.push(generation + 1);
      } else if (isIncluded && !known.has(parent)) {
        // A parent exists but the depth/since gate cut it off: this
        // commit is the shallow boundary of the new pack.
        boundary.add(sha);
      }
    }
  }

  const unshallow: string[] = [];
  for (const sha of request.clientShallow) {
    const object = getObject(repo, sha);
    if (object === null || object.type !== 'commit') continue;
    const parents = parseCommit(object.data).parents;
    if (parents.some((parent) => includedCommits.has(parent))) unshallow.push(sha);
  }

  return {
    objects: [...included.values()],
    key: [...included.keys()].join(' '),
    shallow: [...boundary],
    unshallow,
    common: request.haves.filter((sha) => getObject(repo, sha) !== null),
    hitAbsent,
  };
}

/**
 * Framed pack buffers repeat constantly in a trial (fifty clones of one
 * repo ask for the same objects), and a pack is a pure function of its
 * object list, which is content-addressed: memoize the sideband-framed
 * pack by its object shas, so a repeat fetch copies nothing at all — the
 * cached buffer goes straight to the socket.
 */
const framedPackCache = new Map<string, Buffer>();

/** Frame pack bytes as sideband-64k packets (band 1) in one allocation. */
function frameSideband(pack: Buffer): Buffer {
  const CHUNK = 32768;
  const chunks = Math.max(1, Math.ceil(pack.length / CHUNK));
  const out = Buffer.allocUnsafe(pack.length + chunks * 5);
  let read = 0;
  let written = 0;
  for (let i = 0; i < chunks; i += 1) {
    const count = Math.min(CHUNK, pack.length - read);
    writePktLength(out, written, count + 5);
    out[written + 4] = 1;
    pack.copy(out, written + 5, read, read + count);
    read += count;
    written += count + 5;
  }
  return out;
}

/** Build (or fetch from the cache) the framed pack for a fetch plan. */
function framedPackFor(plan: FetchPlan): Buffer {
  const cached = framedPackCache.get(plan.key);
  if (cached !== undefined) return cached;
  const framed = frameSideband(buildPack(plan.objects));
  if (framedPackCache.size >= 128) {
    const oldest = framedPackCache.keys().next().value;
    if (oldest !== undefined) framedPackCache.delete(oldest);
  }
  framedPackCache.set(plan.key, framed);
  return framed;
}

/**
 * Answer with several buffers written in order: the same bytes and the
 * same headers sendBytes would send for their concatenation, without the
 * copy a concatenation of a large pack would make.
 */
function sendParts(ctx: Ctx, status: number, parts: Buffer[], contentType: string, headers: Record<string, string> = {}): void {
  let length = 0;
  for (const part of parts) length += part.length;
  ctx.res.writeHead(status, {
    'content-type': contentType,
    'content-length': length,
    'x-github-request-id': store.nextRequestId(),
    ...headers,
  });
  for (const part of parts) ctx.res.write(part);
  ctx.res.end();
}

/** The v2 capability advertisement: the same bytes for every repository and every request. */
const V2_ADVERTISEMENT = Buffer.concat([
  pktLine('version 2\n'),
  pktLine(`agent=${AGENT}\n`),
  pktLine('ls-refs=unborn\n'),
  pktLine('fetch=shallow filter\n'),
  pktLine('object-format=sha1\n'),
  pktFlush(),
]);

/** The v0/v2 ref advertisement for one service. */
function advertisement(ctx: Ctx, repo: RepoRec, service: string): void {
  const version2 = (ctx.req.headers['git-protocol'] ?? '').includes('version=2');
  if (service === 'git-upload-pack' && version2) {
    return sendBytes(ctx, 200, V2_ADVERTISEMENT, 'application/x-git-upload-pack-advertisement', { 'cache-control': 'no-cache' });
  }
  const caps = service === 'git-upload-pack' ? UPLOAD_CAPS_V0 : RECEIVE_CAPS;
  const parts: Buffer[] = [pktLine(`# service=${service}\n`), pktFlush()];
  const head = headSha(repo);
  parts.push(pktLine(`${head} HEAD\0${caps} agent=${AGENT}\n`));
  const refs = [...repo.refs.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1));
  for (const [ref, sha] of refs) {
    parts.push(pktLine(`${sha} ${ref}\n`));
    const peeled = peel(repo, sha);
    if (peeled.type === 'commit' && peeled.sha !== sha) parts.push(pktLine(`${peeled.sha} ${ref}^{}\n`));
  }
  parts.push(pktFlush());
  return sendBytes(ctx, 200, Buffer.concat(parts), `application/x-${service}-advertisement`, { 'cache-control': 'no-cache' });
}

/**
 * A packet payload as a text line (no trailing newline). The newline is
 * stripped by length, not by regex: a 0x0a byte can only be the newline
 * itself, never part of a multi-byte utf8 sequence.
 */
function lineText(payload: Buffer): string {
  const end = payload.length > 0 && payload[payload.length - 1] === 0x0a ? payload.length - 1 : payload.length;
  return payload.toString('utf8', 0, end);
}

/** Data payloads of a packet list as text lines (no trailing newline). */
function linesOf(packets: Packet[]): string[] {
  const lines: string[] = [];
  for (const packet of packets) {
    if (packet.kind === 'data') lines.push(lineText(packet.payload));
  }
  return lines;
}

/** Answer a v2 ls-refs command. */
function lsRefs(repo: RepoRec, argLines: string[]): Buffer {
  let peelRequested = false;
  let symrefs = false;
  let unborn = false;
  const prefixes: string[] = [];
  for (const line of argLines) {
    if (line === 'peel') peelRequested = true;
    else if (line === 'symrefs') symrefs = true;
    else if (line === 'unborn') unborn = true;
    else if (line.startsWith('ref-prefix ')) prefixes.push(line.slice('ref-prefix '.length));
  }
  const matches = (name: string): boolean => prefixes.length === 0 || prefixes.some((prefix) => name.startsWith(prefix));
  const parts: Buffer[] = [];
  const head = headSha(repo);
  const headBorn = head !== ZERO_SHA;
  if (matches('HEAD')) {
    let line = `${head} HEAD`;
    if (symrefs) line += ` symref-target:refs/heads/${repo.defaultBranch}`;
    if (unborn && !headBorn) line += ' unborn';
    parts.push(pktLine(`${line}\n`));
  }
  const refs = [...repo.refs.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1));
  for (const [ref, sha] of refs) {
    if (!matches(ref)) continue;
    let line = `${sha} ${ref}`;
    if (peelRequested) {
      const peeled = peel(repo, sha);
      if (peeled.sha !== sha) line += ` peeled:${peeled.sha}`;
    }
    parts.push(pktLine(`${line}\n`));
  }
  parts.push(pktFlush());
  return Buffer.concat(parts);
}

/** Parse the argument lines of a v2 fetch or a v0 fetch into one request shape. */
function parseFetchArgs(lines: string[]): FetchRequest {
  const request: FetchRequest = {
    wants: [],
    wantRefs: [],
    haves: [],
    clientShallow: [],
    depth: null,
    deepenSince: null,
    deepenNot: [],
    filter: null,
    done: false,
  };
  for (const line of lines) {
    if (line.startsWith('want ')) request.wants.push(line.slice(5).trim());
    else if (line.startsWith('want-ref ')) request.wantRefs.push(line.slice(9).trim());
    else if (line.startsWith('have ')) request.haves.push(line.slice(5).trim());
    else if (line.startsWith('shallow ')) request.clientShallow.push(line.slice(8).trim());
    else if (line.startsWith('deepen-since ')) request.deepenSince = Number(line.slice(13).trim());
    else if (line.startsWith('deepen-not ')) request.deepenNot.push(line.slice(11).trim());
    else if (line.startsWith('deepen ')) request.depth = Number(line.slice(7).trim());
    else if (line.startsWith('filter ')) request.filter = parseFilter(line.slice(7).trim());
    else if (line === 'done') request.done = true;
  }
  return request;
}

/** Answer an upload-pack POST, v2 or v0 according to the Git-Protocol header. */
function uploadPack(ctx: Ctx, repo: RepoRec): void {
  const version2 = (ctx.req.headers['git-protocol'] ?? '').includes('version=2');
  const { packets } = parsePackets(ctx.body);

  if (version2) {
    // Capability lines run to the delimiter; argument lines follow it.
    let command = '';
    const argLines: string[] = [];
    let pastDelim = false;
    for (const packet of packets) {
      if (packet.kind === 'delim') {
        pastDelim = true;
        continue;
      }
      if (packet.kind !== 'data') continue;
      const line = lineText(packet.payload);
      if (!pastDelim) {
        if (line.startsWith('command=')) command = line.slice('command='.length);
      } else {
        argLines.push(line);
      }
    }
    if (command === 'ls-refs') {
      return sendBytes(ctx, 200, lsRefs(repo, argLines), 'application/x-git-upload-pack-result', { 'cache-control': 'no-cache' });
    }
    if (command === 'fetch') {
      const request = parseFetchArgs(argLines);
      for (const ref of request.wantRefs) {
        const sha = repo.refs.get(ref);
        if (sha !== undefined && !request.wants.includes(sha)) request.wants.push(sha);
      }
      const plan = planFetch(repo, request);
      const parts: Buffer[] = [];
      if (request.haves.length > 0 || !request.done) {
        parts.push(pktLine('acknowledgments\n'));
        if (plan.common.length > 0) {
          for (const sha of plan.common) parts.push(pktLine(`ACK ${sha}\n`));
        } else {
          parts.push(pktLine('NAK\n'));
        }
        parts.push(pktDelim());
        if (!request.done) {
          parts.push(pktFlush());
          return sendBytes(ctx, 200, Buffer.concat(parts), 'application/x-git-upload-pack-result', { 'cache-control': 'no-cache' });
        }
      }
      if (plan.shallow.length > 0 || plan.unshallow.length > 0) {
        parts.push(pktLine('shallow-info\n'));
        for (const sha of plan.shallow) parts.push(pktLine(`shallow ${sha}\n`));
        for (const sha of plan.unshallow) parts.push(pktLine(`unshallow ${sha}\n`));
        parts.push(pktDelim());
      }
      if (request.wantRefs.length > 0) {
        parts.push(pktLine('wanted-refs\n'));
        for (const ref of request.wantRefs) {
          const sha = repo.refs.get(ref);
          if (sha !== undefined) parts.push(pktLine(`${sha} ${ref}\n`));
        }
        parts.push(pktDelim());
      }
      parts.push(pktLine('packfile\n'));
      parts.push(framedPackFor(plan));
      parts.push(pktFlush());
      return sendParts(ctx, 200, parts, 'application/x-git-upload-pack-result', { 'cache-control': 'no-cache' });
    }
    return sendError(ctx, 400, 'Bad Request');
  }

  // v0: want section, flush, have section, flush — one flat packet stream.
  const allLines = linesOf(parseAllPackets(ctx.body));
  const request = parseFetchArgs(allLines);
  const plan = planFetch(repo, request);
  const parts: Buffer[] = [];
  for (const sha of plan.shallow) parts.push(pktLine(`shallow ${sha}\n`));
  for (const sha of plan.unshallow) parts.push(pktLine(`unshallow ${sha}\n`));
  if (plan.common.length > 0) parts.push(pktLine(`ACK ${plan.common[0]}\n`));
  else parts.push(pktLine('NAK\n'));
  parts.push(framedPackFor(plan));
  parts.push(pktFlush());
  return sendParts(ctx, 200, parts, 'application/x-git-upload-pack-result', { 'cache-control': 'no-cache' });
}

interface RefUpdate {
  oldSha: string;
  newSha: string;
  ref: string;
}

/** Answer a receive-pack POST: unpack, validate fast-forwards, move refs, report. */
function receivePack(ctx: Ctx, repo: RepoRec): void {
  const { packets, rest } = parsePackets(ctx.body);
  const commandLines = linesOf(packets);
  const updates: RefUpdate[] = [];
  let capabilities = '';
  commandLines.forEach((raw, index) => {
    let line = raw;
    if (index === 0) {
      const nul = line.indexOf('\0');
      if (nul !== -1) {
        capabilities = line.slice(nul + 1);
        line = line.slice(0, nul);
      }
    }
    const match = /^([0-9a-f]{40}) ([0-9a-f]{40}) (\S+)$/.exec(line.trim());
    if (match !== null) updates.push({ oldSha: match[1] as string, newSha: match[2] as string, ref: match[3] as string });
  });
  const caps = new Set(capabilities.split(' ').filter(Boolean));
  const wantsReport = caps.has('report-status') || caps.has('report-status-v2');
  const sideband = caps.has('side-band-64k');

  let unpackError: string | null = null;
  if (rest.length > 0) {
    try {
      const staged = parsePack(rest, (sha) => getObject(repo, sha));
      for (const [sha, object] of staged) {
        if (!repo.objects.has(sha)) repo.objects.set(sha, object);
      }
    } catch (err) {
      unpackError = err instanceof Error ? err.message : 'unpack failed';
    }
  }

  const results: { ref: string; ok: boolean; reason?: string }[] = [];
  for (const update of updates) {
    if (unpackError !== null) {
      results.push({ ref: update.ref, ok: false, reason: 'unpacker error' });
      continue;
    }
    const current = repo.refs.get(update.ref) ?? ZERO_SHA;
    if (update.newSha === ZERO_SHA) {
      // A delete: the ref must exist at the named old value.
      if (current === ZERO_SHA || current !== update.oldSha) {
        results.push({ ref: update.ref, ok: false, reason: 'reference does not exist' });
      } else {
        repo.refs.delete(update.ref);
        results.push({ ref: update.ref, ok: true });
      }
      continue;
    }
    const target = getObject(repo, update.newSha);
    if (target === null) {
      results.push({ ref: update.ref, ok: false, reason: 'unknown object' });
      continue;
    }
    if (update.oldSha === ZERO_SHA) {
      if (current !== ZERO_SHA) {
        results.push({ ref: update.ref, ok: false, reason: 'reference already exists' });
        continue;
      }
    } else {
      if (current !== update.oldSha) {
        results.push({ ref: update.ref, ok: false, reason: 'stale info' });
        continue;
      }
      if (target.type === 'commit' && !store.isAncestor(repo, update.oldSha, update.newSha)) {
        results.push({ ref: update.ref, ok: false, reason: 'non-fast-forward' });
        continue;
      }
    }
    repo.refs.set(update.ref, update.newSha);
    repo.updatedAt = store.nowIso();
    results.push({ ref: update.ref, ok: true });
  }

  if (!wantsReport) {
    return sendBytes(ctx, 200, Buffer.alloc(0), 'application/x-git-receive-pack-result', { 'cache-control': 'no-cache' });
  }
  const reportLines: string[] = [unpackError === null ? 'unpack ok' : `unpack ${unpackError}`];
  for (const result of results) {
    reportLines.push(result.ok ? `ok ${result.ref}` : `ng ${result.ref} ${result.reason ?? 'failed'}`);
  }
  const report = Buffer.concat([...reportLines.map((line) => pktLine(`${line}\n`)), pktFlush()]);
  if (!sideband) {
    return sendBytes(ctx, 200, report, 'application/x-git-receive-pack-result', { 'cache-control': 'no-cache' });
  }
  const wrapped: Buffer[] = [];
  const CHUNK = 32768;
  for (let offset = 0; offset < report.length; offset += CHUNK) {
    wrapped.push(pktLine(Buffer.concat([Buffer.from([1]), report.subarray(offset, offset + CHUNK)])));
  }
  wrapped.push(pktFlush());
  return sendBytes(ctx, 200, Buffer.concat(wrapped), 'application/x-git-receive-pack-result', { 'cache-control': 'no-cache' });
}

/** Route one /{owner}/{repo}.git request. */
export function handleGit(ctx: Ctx): void {
  const owner = ctx.segments[0] as string;
  const repoName = (ctx.segments[1] as string).replace(/\.git$/, '');
  const repo = store.getRepo(owner, repoName);
  if (repo === null) {
    sendError(ctx, 404, 'Not Found');
    return;
  }
  // Every git tail is a single segment (info/refs, git-upload-pack,
  // git-receive-pack); only a longer path pays for the slice and join.
  const tail = ctx.segments.length === 3 ? (ctx.segments[2] as string) : ctx.segments.slice(2).join('/');
  const service = ctx.query.get('service');
  if (ctx.method === 'GET' && tail === 'info/refs' && (service === 'git-upload-pack' || service === 'git-receive-pack')) {
    advertisement(ctx, repo, service);
    return;
  }
  if (ctx.method === 'POST' && tail === 'git-upload-pack') {
    uploadPack(ctx, repo);
    return;
  }
  if (ctx.method === 'POST' && tail === 'git-receive-pack') {
    receivePack(ctx, repo);
    return;
  }
  sendError(ctx, 404, 'Not Found');
}
