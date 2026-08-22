// Storage garbage collection: presigned-but-never-completed media objects,
// project media no doc references, long-terminal render jobs, and storage
// reclamation for lapsed subscriptions past their grace window. Runs from
// the Vercel daily cron (vercel.json) or a superuser hitting
// GET /api/cut-cloud/gc.
import { prisma } from "@/lib/prisma";
import { graceDeadline } from "./grace";
import { cutLimitsFor, FREE_STORAGE_BYTES } from "./limits";
import { collectable, listSweepableLadders, pruneLadder, readLadder } from "./ladderStore";
import { deleteLibraryAssetCascade } from "./library";
import { deleteProjectCascade } from "./projects";
import { del, deletePrefix, INFERENCE_PREFIX, listOlderThan, projectHlsRoot } from "./r2";
import { addUsage } from "./usage";

const PENDING_MAX_AGE_MS = 24 * 60 * 60 * 1000;
// Scratch media a hosted inference call carried. No row tracks these — they are
// found by prefix and live only as long as the calls that might reuse them.
const SCRATCH_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const ORPHAN_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const JOB_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
// A deleted library asset leaves a row behind so the iOS app can take the same
// clip off the phone. A phone that has not synced in a season has a bigger
// problem than a missed delete, so the row goes after that.
const LIBRARY_TOMBSTONE_MAX_AGE_MS = 90 * 24 * 60 * 60 * 1000;
const TERMINAL_STATES = ["done", "error", "canceled"];
// Reclamation converges over daily runs rather than risking one long one.
const RECLAIM_SCAN_LIMIT = 500;
const RECLAIM_MAX_USERS = 10;
const RECLAIM_MAX_DELETES_PER_USER = 25;

// A re-rendered HLS ladder is written to a NEW version prefix so viewers on
// the old one keep playing off the edge cache. That makes the previous ladder
// garbage the moment the new one publishes — but not immediately collectable,
// because someone may still be watching it. A day of grace clears any single
// sitting, timed from when the version was RETIRED (the record carries that
// stamp) rather than from when its bytes were written, which for a ladder built
// weeks ago is already long past and would mean no grace at all.
const HLS_RETIRED_GRACE_MS = 24 * 60 * 60 * 1000;
// A version claimed but never published belongs to a render that is either
// still going or dead. The longest a ladder can legitimately take is bounded by
// the worker's own job lifetime, so past this it is a dead render's leftovers.
const HLS_PENDING_TIMEOUT_MS = 6 * 60 * 60 * 1000;

type ReclaimPlan = { projects: string[]; assets: string[]; bytes: number };

/**
 * Drop ladder versions a project has moved on from, and the leftovers of
 * renders that died partway.
 *
 * Ladders carry no media rows and no storage quota, so the record in KV is the
 * only index of them and this is a pure prefix delete. Two clocks decide what
 * goes: a retired version leaves a day after it stopped being current, and a
 * pending version — one claimed before upload whose render never published —
 * leaves once it is too old to still be running.
 *
 * The work scales with the garbage, not the project count: only records that
 * carry retired or pending versions are listed at all, and a swept record drops
 * out of that set. So there is no per-run project cap to strand the tail of the
 * namespace behind the same first hundred keys every night.
 */
async function sweepStaleLadders() {
  const out = { projects: 0, versions: 0, objects: 0, failed: 0 };
  const now = Date.now();
  for (const { projectId } of await listSweepableLadders()) {
    try {
      const record = await readLadder(projectId);
      if (!record) continue;
      const drop = collectable(record, now, HLS_RETIRED_GRACE_MS, HLS_PENDING_TIMEOUT_MS);
      if (drop.length === 0) continue;
      const root = projectHlsRoot(record.userId, projectId);
      const dropped = new Set<string>();
      for (const version of drop) {
        out.objects += await deletePrefix(`${root}${version}/`);
        dropped.add(version);
      }
      // Only now does the record forget them: pruning first would unindex the
      // objects if the delete then failed.
      await pruneLadder(projectId, record, dropped);
      out.projects += 1;
      out.versions += dropped.size;
    } catch {
      // One project's sweep failing must not fail the cron, and the record
      // still names its garbage, so the next run tries again.
      out.failed += 1;
    }
  }
  return out;
}

/** What the sweep can actually free for one account, oldest first: whole
 * projects, then library assets, stopping as soon as the plan covers `target`.
 * Sizes come from the media rows themselves, so a drifted usage counter can
 * never widen a deletion, and anything that would free nothing is left out —
 * it costs the user their work and buys no space. */
async function reclaimPlan(userId: string, target: number): Promise<ReclaimPlan> {
  const plan: ReclaimPlan = { projects: [], assets: [], bytes: 0 };
  const projects = await prisma.cutProject.findMany({
    where: { userId },
    orderBy: { updatedAt: "asc" },
    select: { id: true },
  });
  const sums = await prisma.cutMediaObject.groupBy({
    by: ["projectId"],
    where: {
      userId,
      projectId: { in: projects.map((p) => p.id) },
      uploadState: "complete",
      // Exempt bytes never counted toward the quota, so deleting them frees
      // nothing the quota can see — they must not pad a project's claim.
      quotaExempt: false,
    },
    _sum: { bytes: true },
  });
  const projectBytes = new Map(sums.map((s) => [s.projectId as string, Number(s._sum.bytes ?? 0)]));
  for (const p of projects) {
    if (plan.bytes >= target) return plan;
    const size = projectBytes.get(p.id) ?? 0;
    if (size <= 0) continue;
    plan.projects.push(p.id);
    plan.bytes += size;
  }

  const assets = await prisma.cutLibraryAsset.findMany({
    where: { userId, deletedAt: null },
    orderBy: { createdAt: "asc" },
    select: { id: true, mediaObjectId: true },
  });
  const objects = await prisma.cutMediaObject.findMany({
    where: {
      userId,
      uploadState: "complete",
      id: { in: assets.map((a) => a.mediaObjectId) },
    },
    select: { id: true, bytes: true },
  });
  const assetBytes = new Map(objects.map((o) => [o.id, Number(o.bytes)]));
  for (const a of assets) {
    if (plan.bytes >= target) break;
    const size = assetBytes.get(a.mediaObjectId) ?? 0;
    if (size <= 0) continue;
    plan.assets.push(a.id);
    plan.bytes += size;
  }
  return plan;
}

/** Bring accounts whose Pro ended and whose grace window has passed back under
 * the free storage cap: least-recently-updated projects first, then the oldest
 * library assets. The plan is built and checked before anything is deleted, so
 * an account whose overage the sweep cannot reach is reported rather than
 * emptied, and content under the cap is never touched. */
async function reclaimOverQuota() {
  const out = {
    users: 0,
    projects: 0,
    libraryAssets: 0,
    bytes: 0,
    // Left for tomorrow by the per-run caps: a truncated sweep has to look
    // truncated in the summary, not finished.
    deferred: 0,
    // Over the cap with nothing worth deleting — needs a human, not a sweep.
    unreclaimable: 0,
    failed: 0,
  };
  const overCap = await prisma.cutStorageUsage.findMany({
    where: { bytes: { gt: BigInt(FREE_STORAGE_BYTES) } },
    orderBy: { bytes: "desc" },
    take: RECLAIM_SCAN_LIMIT,
    select: { userId: true },
  });
  if (overCap.length === 0) return out;
  // One read for the whole batch: most accounts over the free cap are paying
  // ones the sweep will never touch, and they are not worth a query each.
  const subs = await prisma.proSubscription.findMany({
    where: { userId: { in: overCap.map((r) => r.userId) } },
    select: { userId: true, status: true, currentPeriodEnd: true },
  });
  const now = Date.now();
  const lapsed = subs.filter((s) => {
    const deadline = graceDeadline(s);
    return deadline !== null && now >= deadline.getTime();
  });

  for (const { userId } of lapsed) {
    if (out.users >= RECLAIM_MAX_USERS) {
      out.deferred += 1;
      continue;
    }
    try {
      // Re-read the tier: a superuser flag or a resubscribe since the scan
      // takes the account back out of reach.
      const limits = await cutLimitsFor(userId);
      if (limits.storageBytes === null || limits.storageBytes > FREE_STORAGE_BYTES) continue;
      const stored = await prisma.cutMediaObject.aggregate({
        where: { userId, uploadState: "complete", quotaExempt: false },
        _sum: { bytes: true },
      });
      const target = Number(stored._sum.bytes ?? 0) - limits.storageBytes;
      if (target <= 0) continue;

      const plan = await reclaimPlan(userId, target);
      if (plan.bytes < target) {
        out.unreclaimable += 1;
        continue;
      }
      out.users += 1;
      let budget = RECLAIM_MAX_DELETES_PER_USER;
      for (const projectId of plan.projects) {
        if (budget <= 0) break;
        out.bytes += await deleteProjectCascade(userId, projectId);
        out.projects += 1;
        budget -= 1;
      }
      for (const assetId of plan.assets) {
        if (budget <= 0) break;
        out.bytes += (await deleteLibraryAssetCascade(userId, assetId)) ?? 0;
        out.libraryAssets += 1;
        budget -= 1;
      }
      if (plan.projects.length + plan.assets.length > RECLAIM_MAX_DELETES_PER_USER) {
        out.deferred += 1;
      }
    } catch {
      // One account's failure — a project deleted underneath us, an R2 blip —
      // must not stop the sweep or fail the cron.
      out.failed += 1;
    }
  }
  return out;
}

export async function runGc(): Promise<Response> {
  const pending = await prisma.cutMediaObject.findMany({
    where: {
      uploadState: "pending",
      createdAt: { lt: new Date(Date.now() - PENDING_MAX_AGE_MS) },
    },
    select: { id: true, r2Key: true },
  });
  // Pending rows never counted toward usage, so no usage adjustment here.
  await del(pending.map((o) => o.r2Key));
  if (pending.length > 0) {
    await prisma.cutMediaObject.deleteMany({
      where: { id: { in: pending.map((o) => o.id) } },
    });
  }
  // Unreferenced project media: bytes a worker or client landed in a project
  // whose doc never adopted them — an abandoned import, a tab closed before
  // the save. The doc is the sole owner of project media, adoption happens
  // within seconds of landing, and the one delayed delivery path (the cloud
  // import poll) caps at ten minutes — so after a day of grace, unreferenced
  // means garbage. Docs of deleted projects are gone too, which orphans (and
  // sweeps) any rows their deletion missed.
  const mediaCandidates = await prisma.cutMediaObject.findMany({
    where: {
      kind: "media",
      uploadState: "complete",
      projectId: { not: null },
      updatedAt: { lt: new Date(Date.now() - ORPHAN_MAX_AGE_MS) },
    },
    select: {
      id: true,
      userId: true,
      projectId: true,
      fileName: true,
      r2Key: true,
      bytes: true,
      quotaExempt: true,
    },
  });
  const docProjects = await prisma.cutProject.findMany({
    where: { id: { in: [...new Set(mediaCandidates.map((c) => c.projectId!))] } },
    select: { id: true, doc: true },
  });
  const referenced = new Map(
    docProjects.map((p) => {
      const assets = (p.doc as { assets?: { fileName?: string }[] } | null)?.assets ?? [];
      return [p.id, new Set(assets.map((a) => a.fileName))];
    })
  );
  const orphans = mediaCandidates.filter((c) => !referenced.get(c.projectId!)?.has(c.fileName));
  const byUser = new Map<string, typeof orphans>();
  for (const o of orphans) {
    const list = byUser.get(o.userId) ?? [];
    list.push(o);
    byUser.set(o.userId, list);
  }
  for (const [userId, rows] of byUser) {
    // Quota-exempt rows never added usage, so only the counted ones subtract.
    const counted = rows.filter((r) => !r.quotaExempt);
    await prisma.$transaction(async (tx) => {
      await tx.cutMediaObject.deleteMany({ where: { id: { in: rows.map((r) => r.id) } } });
      await addUsage(tx, userId, -counted.reduce((sum, r) => sum + Number(r.bytes), 0));
    });
    await del(rows.map((r) => r.r2Key));
  }

  // Old terminal jobs go together with their overlay PNGs — the worker deletes
  // overlays when it settles a job, but a job canceled while still queued was
  // never claimed, so its overlays only die here.
  const oldJobs = await prisma.cutRenderJob.findMany({
    where: {
      state: { in: TERMINAL_STATES },
      createdAt: { lt: new Date(Date.now() - JOB_MAX_AGE_MS) },
    },
    select: { id: true, userId: true, spec: true },
  });
  const overlayKeys = oldJobs.flatMap((j) => {
    const overlays = (j.spec as { overlays?: { key?: unknown }[] } | null)?.overlays ?? [];
    const prefix = `cut/${j.userId}/overlays/`;
    return overlays
      .map((o) => o?.key)
      .filter((k): k is string => typeof k === "string" && k.startsWith(prefix));
  });
  await del(overlayKeys);
  const jobs =
    oldJobs.length > 0
      ? await prisma.cutRenderJob.deleteMany({ where: { id: { in: oldJobs.map((j) => j.id) } } })
      : { count: 0 };

  // Scratch inference media, swept by prefix: it never counted toward usage and
  // no row points at it, so age is the only thing that makes it garbage. The
  // nightly analytics pipeline also keeps rowless JSON under analytics/ — any
  // future sweep of unknown prefixes must leave that tree alone.
  const scratch = await listOlderThan(
    INFERENCE_PREFIX,
    new Date(Date.now() - SCRATCH_MAX_AGE_MS)
  ).catch(() => [] as string[]);
  await del(scratch);

  // Guarded like the prefix sweeps above it: the ladder store is optional
  // infrastructure whose loss costs a re-render, so a missing token or an
  // unreachable KV must not take down the run that reclaims storage.
  const ladders = await sweepStaleLadders().catch((e: unknown) => {
    console.error("[cut-gc] ladder sweep failed:", e instanceof Error ? e.message : e);
    return { projects: 0, versions: 0, objects: 0, failed: 1 };
  });

  // Library tombstones past the window every client has had to see them in.
  // Their bytes went with the delete; this is the empty row.
  const tombstones = await prisma.cutLibraryAsset.deleteMany({
    where: { deletedAt: { lt: new Date(Date.now() - LIBRARY_TOMBSTONE_MAX_AGE_MS) } },
  });

  const reclaimed = await reclaimOverQuota();

  return Response.json({
    pendingObjects: pending.length,
    orphanedMedia: orphans.length,
    inferenceScratch: scratch.length,
    renderJobs: jobs.count,
    libraryTombstones: tombstones.count,
    staleLadderProjects: ladders.projects,
    staleLadderVersions: ladders.versions,
    staleLadderObjects: ladders.objects,
    staleLadderFailures: ladders.failed,
    reclaimedUsers: reclaimed.users,
    reclaimedProjects: reclaimed.projects,
    reclaimedLibraryAssets: reclaimed.libraryAssets,
    reclaimedBytes: reclaimed.bytes,
    reclaimDeferredUsers: reclaimed.deferred,
    reclaimUnreclaimableUsers: reclaimed.unreclaimable,
    reclaimFailedUsers: reclaimed.failed,
  });
}
