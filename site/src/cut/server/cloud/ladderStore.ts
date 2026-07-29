// Where a project's HLS ladders are recorded.
//
// This is derived state, not user data: it says which ladder is current and
// which are on their way out, and losing it costs a re-render. So it lives in
// Cloudflare KV rather than in the project row — no schema to migrate, and a
// record that is rebuildable by construction.
//
// The record tracks every tree the project has ever started, not just the one
// it serves. That is the load-bearing part. A ladder is hundreds of R2 objects
// with no database rows, and this record is the only index of them, so a tree
// that never made it in would be invisible to every sweep and leak forever.
// Hence `pending`: a version is written here BEFORE its first byte is uploaded,
// so a job that dies mid-upload still leaves a trail. And hence `retired`,
// which carries the moment a version was replaced — the grace a viewer gets is
// measured from when their ladder stopped being current, not from when its
// bytes happened to be written.
//
// Neither writer runs inside a Worker (the site is on Vercel, the render worker
// is a container), so both reach KV over the REST API, the same way copyQueue
// publishes to Cloudflare Queues. The namespace is addressed by title and
// resolved once per process; only the token comes from the environment.
const KV_NAMESPACE_TITLE = "donkey-cut-ladders";

const KEY_PREFIX = "hls:";
const ladderKey = (projectId: string) => `${KEY_PREFIX}${projectId}`;

/** How many retired versions a record keeps. The sweep clears them within a
 * day, so this only has to survive a burst of re-renders; past it the oldest
 * are dropped from the record and collected by the unindexed-tree sweep. */
const MAX_RETIRED = 12;

/** One published ladder. */
export interface LadderVersion {
  /** Path segment the ladder's objects live under. */
  version: string;
  /** Seconds of cut, which sizes the viewer's access token. */
  duration: number;
  /**
   * Whether captions are burned into these pixels.
   *
   * Recorded because it cannot be undone downstream: a share that does not
   * grant Subtitles must not be served a render with the cue text in the
   * frame, and by then it is pixels rather than a field to strip.
   */
  burnedSubtitles: boolean;
}

/** What a project's ladders look like. */
export interface LadderRecord {
  userId: string;
  /** The ladder a share plays. Absent until the first one publishes. */
  current?: LadderVersion;
  /** Replaced ladders, with when they were replaced — the clock the sweep's
   * grace period actually runs on. */
  retired?: { version: string; at: number }[];
  /** Versions whose upload began and never published. A live render owns one;
   * one left behind by a dead render is garbage, told apart by age. */
  pending?: { version: string; at: number }[];
}

/** What the key listing carries, so the sweep can skip projects with nothing to
 * collect without fetching each record. Kept tiny: KV caps metadata at 1 KiB. */
interface LadderMeta {
  u: string;
  /** Count of retired + pending entries; 0 means nothing to sweep. */
  g: number;
}

/** A deployment without the KV token cannot record or find a ladder, so shares
 * cannot stream at all. Carried as its own type for the same reason
 * MediaNotConfiguredError is: the message names an environment variable, and
 * routes answer in their own words rather than echoing it to whoever asked —
 * including an anonymous share viewer. */
export class LadderStoreNotConfiguredError extends Error {
  constructor() {
    super("CLOUDFLARE_KV_API_TOKEN is not set — share streams cannot be recorded or served");
  }
}

function credentials(): { accountId: string; token: string } {
  const accountId = process.env.R2_ACCOUNT_ID;
  const token = process.env.CLOUDFLARE_KV_API_TOKEN;
  if (!accountId || !token) throw new LadderStoreNotConfiguredError();
  return { accountId, token };
}

let cachedNamespaceId: string | null = null;

/** Find the namespace by title, creating it the first time. Creating it here
 * rather than as a deploy step means the only setup a deployment needs is the
 * token — and a token scoped to write KV can already make one. */
async function namespaceId(accountId: string, token: string): Promise<string> {
  if (cachedNamespaceId) return cachedNamespaceId;
  const root = `https://api.cloudflare.com/client/v4/accounts/${accountId}/storage/kv/namespaces`;
  const auth = { Authorization: `Bearer ${token}` };
  // Paged: an account with many namespaces would otherwise hide ours past the
  // first page and send this down the create path on every call.
  for (let page = 1; page <= 10; page++) {
    const res = await fetch(`${root}?per_page=100&page=${page}`, { headers: auth });
    if (!res.ok) throw new Error(`KV namespace list failed: ${res.status}`);
    const body = (await res.json()) as { result?: { id?: string; title?: string }[] };
    const found = body.result?.find((n) => n.title === KV_NAMESPACE_TITLE);
    if (found?.id) return (cachedNamespaceId = found.id);
    if (!body.result || body.result.length < 100) break;
  }
  const created = await fetch(root, {
    method: "POST",
    headers: { ...auth, "Content-Type": "application/json" },
    body: JSON.stringify({ title: KV_NAMESPACE_TITLE }),
  });
  if (created.ok) {
    const body = (await created.json()) as { result?: { id?: string } };
    if (body.result?.id) return (cachedNamespaceId = body.result.id);
  }
  // A racing writer may have created it between the scan and the attempt, so
  // one re-scan decides between "someone beat us" and a real failure.
  const retry = await fetch(`${root}?per_page=100`, { headers: auth });
  if (retry.ok) {
    const body = (await retry.json()) as { result?: { id?: string; title?: string }[] };
    const found = body.result?.find((n) => n.title === KV_NAMESPACE_TITLE);
    if (found?.id) return (cachedNamespaceId = found.id);
  }
  throw new Error(`KV namespace "${KV_NAMESPACE_TITLE}" could not be found or created`);
}

const base = (accountId: string, id: string) =>
  `https://api.cloudflare.com/client/v4/accounts/${accountId}/storage/kv/namespaces/${id}`;

function parseVersion(raw: unknown): LadderVersion | undefined {
  const v = raw as Partial<LadderVersion> | undefined;
  if (!v || typeof v.version !== "string" || !v.version) return undefined;
  return {
    version: v.version,
    duration: Number(v.duration) || 0,
    // Absent means unknown, and unknown has to read as "might have captions" —
    // the safe direction for a boundary that cannot be re-checked later.
    burnedSubtitles: v.burnedSubtitles !== false,
  };
}

function parseStamps(raw: unknown): { version: string; at: number }[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((e): e is { version: string; at: number } => {
      const s = e as { version?: unknown; at?: unknown };
      return typeof s?.version === "string" && !!s.version && Number.isFinite(Number(s?.at));
    })
    .map((e) => ({ version: e.version, at: Number(e.at) }));
}

function parseRecord(raw: unknown): LadderRecord | null {
  const r = raw as Partial<LadderRecord> | null;
  if (!r || typeof r.userId !== "string" || !r.userId) return null;
  return {
    userId: r.userId,
    current: parseVersion(r.current),
    retired: parseStamps(r.retired),
    pending: parseStamps(r.pending),
  };
}

const metaOf = (record: LadderRecord): LadderMeta => ({
  u: record.userId,
  g: (record.retired?.length ?? 0) + (record.pending?.length ?? 0),
});

async function put(projectId: string, record: LadderRecord): Promise<void> {
  const { accountId, token } = credentials();
  const id = await namespaceId(accountId, token);
  const form = new FormData();
  form.set("value", JSON.stringify(record));
  // Metadata rides the key listing, which is what lets the sweep decide whether
  // a project is worth any R2 calls without fetching its record.
  form.set("metadata", JSON.stringify(metaOf(record)));
  const res = await fetch(
    `${base(accountId, id)}/values/${encodeURIComponent(ladderKey(projectId))}`,
    { method: "PUT", headers: { Authorization: `Bearer ${token}` }, body: form }
  );
  if (!res.ok) throw new Error(`KV write failed: ${res.status}`);
}

/** A project's ladder record, or null when it has none.
 *
 * Null means exactly one thing — nothing recorded yet — so a caller can treat
 * it as "still rendering". A misconfigured or unreachable store throws instead,
 * and is never quietly reported as an absent ladder. */
export async function readLadder(projectId: string): Promise<LadderRecord | null> {
  const { accountId, token } = credentials();
  const id = await namespaceId(accountId, token);
  const res = await fetch(
    `${base(accountId, id)}/values/${encodeURIComponent(ladderKey(projectId))}`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`KV read failed: ${res.status}`);
  return parseRecord(await res.json());
}

/**
 * Claim a version before uploading a byte of it.
 *
 * This is what keeps a tree from ever being unindexed. The render mints a
 * version, records it here, and only then uploads; if the container dies or the
 * job is requeued, the half-written tree is still named in the record and the
 * sweep collects it. Writing the pointer after the upload instead would leak
 * the whole tree on every failed render, with nothing left that could find it.
 */
export async function beginLadder(
  projectId: string,
  userId: string,
  version: string
): Promise<void> {
  const existing = (await readLadder(projectId)) ?? { userId };
  await put(projectId, withPending(existing, userId, version, Date.now()));
}

/** `beginLadder`'s state transition, without the IO. */
export function withPending(
  existing: LadderRecord,
  userId: string,
  version: string,
  at: number
): LadderRecord {
  return {
    ...existing,
    userId,
    pending: [
      ...(existing.pending ?? []).filter((p) => p.version !== version),
      { version, at },
    ],
  };
}

/**
 * Publish a finished ladder: it becomes current, whatever it replaced joins
 * `retired` stamped with now, and it stops being pending.
 *
 * The stamp is the point. A viewer mid-watch is holding the version that just
 * stopped being current, and the grace before its segments are deleted has to
 * run from this moment — not from whenever those segments were written, which
 * for a ladder built last week is already long past.
 */
export async function publishLadder(
  projectId: string,
  userId: string,
  next: LadderVersion
): Promise<void> {
  const existing = (await readLadder(projectId)) ?? { userId };
  await put(projectId, withPublished(existing, userId, next, Date.now()));
}

/** `publishLadder`'s state transition, without the IO. */
export function withPublished(
  existing: LadderRecord,
  userId: string,
  next: LadderVersion,
  at: number
): LadderRecord {
  const retired = [
    ...(existing.retired ?? []),
    ...(existing.current && existing.current.version !== next.version
      ? [{ version: existing.current.version, at }]
      : []),
  ].slice(-MAX_RETIRED);
  return {
    userId,
    current: next,
    retired,
    pending: (existing.pending ?? []).filter((p) => p.version !== next.version),
  };
}

/** Which versions a sweep at `now` should delete, given the two clocks: a
 * retired version leaves after `retiredGraceMs` from the moment it stopped
 * being current, a pending one after `pendingTimeoutMs` from when it was
 * claimed. What is currently served is never in the set, whatever else the
 * record says about it. */
export function collectable(
  record: LadderRecord,
  now: number,
  retiredGraceMs: number,
  pendingTimeoutMs: number
): string[] {
  const expired = [
    ...(record.retired ?? []).filter((r) => now - r.at >= retiredGraceMs),
    ...(record.pending ?? []).filter((p) => now - p.at >= pendingTimeoutMs),
  ];
  return [
    ...new Set(expired.map((e) => e.version).filter((v) => v !== record.current?.version)),
  ];
}

/** Rewrite a record after a sweep has removed the trees it named. */
export async function pruneLadder(
  projectId: string,
  record: LadderRecord,
  dropped: Set<string>
): Promise<void> {
  await put(projectId, {
    ...record,
    retired: (record.retired ?? []).filter((r) => !dropped.has(r.version)),
    pending: (record.pending ?? []).filter((p) => !dropped.has(p.version)),
  });
}

/** Forget a project's ladders. Best-effort, and the one place that stays that
 * way: it runs inside a project delete that has already removed the rows and
 * the bytes, and failing a delete the user asked for is worse than a stray key
 * that resolves to an empty prefix. */
export async function deleteLadder(projectId: string): Promise<void> {
  try {
    const { accountId, token } = credentials();
    const id = await namespaceId(accountId, token);
    await fetch(`${base(accountId, id)}/values/${encodeURIComponent(ladderKey(projectId))}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${token}` },
    });
  } catch {
    // The sweep tolerates a record whose trees are already gone.
  }
}

/**
 * Every project with something to collect, read off the listing's metadata.
 *
 * Only records carrying retired or pending versions come back, so a run does
 * work proportional to the garbage that exists rather than to the number of
 * projects — and once a project is swept it drops out of this set. That is
 * what lets the sweep page the whole namespace instead of stopping at a fixed
 * number of projects and never reaching the rest.
 */
export async function listSweepableLadders(): Promise<{ projectId: string; userId: string }[]> {
  const { accountId, token } = credentials();
  const id = await namespaceId(accountId, token);
  const out: { projectId: string; userId: string }[] = [];
  let cursor = "";
  do {
    const url = new URL(`${base(accountId, id)}/keys`);
    url.searchParams.set("prefix", KEY_PREFIX);
    url.searchParams.set("limit", "1000");
    if (cursor) url.searchParams.set("cursor", cursor);
    const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok) throw new Error(`KV list failed: ${res.status}`);
    const body = (await res.json()) as {
      result?: { name?: string; metadata?: LadderMeta }[];
      result_info?: { cursor?: string };
    };
    for (const row of body.result ?? []) {
      if (!row.name || !row.metadata?.u || !(Number(row.metadata.g) > 0)) continue;
      out.push({ projectId: row.name.slice(KEY_PREFIX.length), userId: row.metadata.u });
    }
    cursor = body.result_info?.cursor ?? "";
  } while (cursor);
  return out;
}
