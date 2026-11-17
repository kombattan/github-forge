// Git smart HTTP: the advertisement, ls-refs and fetch of upload-pack
// (protocol v2, with a v0 fallback) and the v0 receive-pack, all served
// from the repository's own object store — no git binary anywhere. The
// dialect follows the suite's client exactly: v2 answers in sections, v0
// fetch answers shallow lines, one ACK or NAK, then the sideband-framed
// pack; pushes are fast-forward only and report per ref.

import {
  getObject,
  parseCommit,
  store,
  type GitObject,
  type RepoRec,
} from './store.ts';
import { sendBytes, sendError, type Ctx } from './http.ts';
import { buildPack, parseAllPackets, parsePack, parsePackets, pktDelim, pktFlush, pktLine, ZERO_SHA, type Packet } from './pack.ts';

const AGENT = 'forge/1.0';
const UPLOAD_CAPS_V0 = 'side-band-64k shallow ofs-delta allow-tip-sha1-in-want';
const RECEIVE_CAPS = 'report-status delete-refs side-band-64k ofs-delta';

/** The commit sha HEAD names (the default branch tip), or the zero sha. */
function headSha(repo: RepoRec): string {
  return store.branchTip(repo, repo.defaultBranch) ?? ZERO_SHA;
}

/** Peel a tag object chain down to the object it ultimately names. */
function peel(repo: RepoRec, sha: string): { sha: string; type: string } {
  let current = sha;
  for (let guard = 0; guard < 16; guard += 1) {
    const object = getObject(repo, current);
    if (object === null) return { sha: current, type: 'unknown' };
    if (object.type !== 'tag') return { sha: current, type: object.type };
    const match = /^object ([0-9a-f]{40})$/m.exec(object.data.toString('utf8'));
    if (match === null) return { sha: current, type: 'tag' };
    current = match[1] as string;
  }
  return { sha: current, type: 'tag' };
}

/** The committer timestamp (unix seconds) of a commit, or 0. */
function commitTime(repo: RepoRec, sha: string): number {
  const object = getObject(repo, sha);
  if (object === null || object.type !== 'commit') return 0;
  const line = parseCommit(object.data).committerLine;
  const match = / (\d+) [+-]\d{4}$/.exec(line);
  return match === null ? 0 : Number(match[1]);
}

/** All objects reachable from a set of commits: the "already known" closure. */
function fullClosure(repo: RepoRec, tips: string[], into: Set<string>, stopAt?: Set<string>): void {
  const stack = [...tips];
  while (stack.length > 0) {
    const sha = stack.pop() as string;
    if (into.has(sha)) continue;
    const object = getObject(repo, sha);
    if (object === null) continue;
    into.add(sha);
    if (object.type === 'commit') {
      const info = parseCommit(object.data);
      stack.push(info.tree);
      // A commit the client holds only as a shallow boundary is known
      // itself, but its ancestry is exactly what it does not have.
      if (stopAt === undefined || !stopAt.has(sha)) stack.push(...info.parents);
    } else if (object.type === 'tree') {
      for (const entry of treeEntries(repo, sha)) stack.push(entry.sha);
    } else if (object.type === 'tag') {
      const target = peel(repo, sha);
      stack.push(target.sha);
    }
  }
}

/** Tree entries of a tree sha (empty for anything else). */
function treeEntries(repo: RepoRec, treeSha: string): { mode: string; name: string; sha: string }[] {
  const object = getObject(repo, treeSha);
  if (object === null || object.type !== 'tree') return [];
  const entries: { mode: string; name: string; sha: string }[] = [];
  let offset = 0;
  const data = object.data;
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset);
    const nul = data.indexOf(0x00, space);
    entries.push({
      mode: data.toString('utf8', offset, space),
      name: data.toString('utf8', space + 1, nul),
      sha: data.toString('hex', nul + 1, nul + 21),
    });
    offset = nul + 21;
  }
  return entries;
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

/** Work out exactly which objects a fetch sends, and its shallow boundary. */
function planFetch(repo: RepoRec, request: FetchRequest): FetchPlan {
  const shallowSet = new Set(request.clientShallow);
  const known = new Set<string>();
  fullClosure(repo, request.haves, known, shallowSet);
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
    if (object === null) return;
    included.set(sha, object);
  };
  const includeTree = (treeSha: string, depth: number): void => {
    const object = getObject(repo, treeSha);
    if (object === null || known.has(treeSha)) return;
    if (!passesFilter(object, request.filter, depth)) return;
    includeObject(treeSha);
    for (const entry of treeEntries(repo, treeSha)) {
      if (entry.mode === '40000') {
        includeTree(entry.sha, depth + 1);
      } else {
        const blob = getObject(repo, entry.sha);
        if (blob !== null && !known.has(entry.sha) && passesFilter(blob, request.filter, depth)) includeObject(entry.sha);
      }
    }
  };

  // Breadth-first over commits so depth counts generations from the wants.
  // The walk goes through commits the client already has — a shallow
  // boundary named as a have is the classic case — leaving known objects
  // out of the pack but still reaching the generations below them, which
  // is exactly what a deepen asks for.
  const queue: { sha: string; generation: number }[] = [];
  const seen = new Set<string>();
  for (const want of request.wants) {
    const object = getObject(repo, want);
    if (object === null) continue;
    if (object.type === 'commit') queue.push({ sha: want, generation: 0 });
    else if (object.type === 'tree') includeTree(want, 0);
    else includeObject(want);
  }
  // An index cursor, not shift(): the walk is breadth-first either way and
  // a long history must not pay a memmove per commit.
  for (let head = 0; head < queue.length; head += 1) {
    const { sha, generation } = queue[head] as { sha: string; generation: number };
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
      if (getObject(repo, parent) === null) continue;
      const parentWithinDepth = request.depth === null || generation + 1 < request.depth;
      const parentWithinSince = request.deepenSince === null || commitTime(repo, parent) >= request.deepenSince;
      if (parentWithinDepth && parentWithinSince) {
        queue.push({ sha: parent, generation: generation + 1 });
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
  };
}

/**
 * Pack buffers repeat constantly in a trial (fifty clones of one repo ask
 * for the same objects), and a pack is a pure function of its object list,
 * which is content-addressed: memoize built packs by their object shas.
 */
const packCache = new Map<string, Buffer>();

/** Build (or fetch from the cache) the pack for a fetch plan. */
function packFor(plan: FetchPlan): Buffer {
  const cached = packCache.get(plan.key);
  if (cached !== undefined) return cached;
  const pack = buildPack(plan.objects);
  if (packCache.size >= 128) {
    const oldest = packCache.keys().next().value;
    if (oldest !== undefined) packCache.delete(oldest);
  }
  packCache.set(plan.key, pack);
  return pack;
}

/** Frame pack bytes as sideband-64k packets (band 1), chunked well under the limit. */
function sidebandPackets(pack: Buffer): Buffer[] {
  const packets: Buffer[] = [];
  const CHUNK = 32768;
  for (let offset = 0; offset < pack.length; offset += CHUNK) {
    const chunk = pack.subarray(offset, offset + CHUNK);
    packets.push(pktLine(Buffer.concat([Buffer.from([1]), chunk])));
  }
  if (packets.length === 0) packets.push(pktLine(Buffer.from([1])));
  return packets;
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

/** Data payloads of a packet list as text lines (no trailing newline). */
function linesOf(packets: Packet[]): string[] {
  const lines: string[] = [];
  for (const packet of packets) {
    if (packet.kind === 'data') lines.push(packet.payload.toString('utf8').replace(/\n$/, ''));
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
      const line = packet.payload.toString('utf8').replace(/\n$/, '');
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
      parts.push(...sidebandPackets(packFor(plan)));
      parts.push(pktFlush());
      return sendBytes(ctx, 200, Buffer.concat(parts), 'application/x-git-upload-pack-result', { 'cache-control': 'no-cache' });
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
  parts.push(...sidebandPackets(packFor(plan)));
  parts.push(pktFlush());
  return sendBytes(ctx, 200, Buffer.concat(parts), 'application/x-git-upload-pack-result', { 'cache-control': 'no-cache' });
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
  const tail = ctx.segments.slice(2).join('/');
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
