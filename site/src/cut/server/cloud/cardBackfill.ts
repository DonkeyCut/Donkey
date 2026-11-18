import { prisma } from "@/lib/prisma";
import { previewFromDoc } from "./previewJobs";

// A project gets its card (preview.mp4) from the editor when someone edits
// it. One that arrives or changes by any other road — Move to Cloud, a
// duplicate, a doc written through the API, a seeded starter — has none, or
// one from before the change, and its tile shows the wrong frame. Listing
// projects hands those to the render worker, which draws the saved doc
// headless, overlays included.

// How many missing or stale cards one listing queues: the newest first, the rest on
// the next visit, so a library of old projects never floods the worker.
export const CARD_BACKFILL_MAX = 4;

// A card render in these states belongs to someone already: the editor's own
// render, or this backfill's from an earlier listing.
const LIVE_STATES = ["queued", "running"];

/** A listed project as the backfill reads it. */
type CardRow = {
  id: string;
  version: number;
  previewKey: string | null;
  duration: number;
  updatedAt: number;
};

const dependencies = { db: prisma, render: previewFromDoc };

/** The revision a card job rendered, e.g. "cloud:7" for doc version 7. */
const revisionOf = (spec: unknown) =>
  spec && typeof spec === "object"
    ? (spec as { revision?: unknown }).revision
    : undefined;

/** When each project's newest card render was asked for. */
async function lastDrawn(db: typeof prisma, userId: string, ids: string[]) {
  const groups = await db.cutRenderJob.groupBy({
    by: ["projectId"],
    where: { userId, kind: "preview", projectId: { in: ids } },
    _max: { createdAt: true },
  });
  return new Map(
    groups.map((g) => [g.projectId, g._max.createdAt?.getTime() ?? 0]),
  );
}

/** Queue a card render for each listed project whose card is missing or
 * was asked for before its last save. A revision gets one attempt: a failed
 * render is not retried until the doc changes. */
export async function backfillCards(
  userId: string,
  rows: CardRow[],
  { db, render } = dependencies,
) {
  const drawable = rows.filter((r) => r.duration > 0);
  if (drawable.length === 0) {
    return;
  }

  // A card is current when a render was asked for at or after the save.
  const drawn = await lastDrawn(
    db,
    userId,
    drawable.map((r) => r.id),
  );
  const missing = drawable.filter(
    (r) => r.previewKey == null || (drawn.get(r.id) ?? 0) < r.updatedAt,
  );
  if (missing.length === 0) {
    return;
  }

  // Every card job these projects have that rules a new one out: one still
  // in flight, or one of this backfill's (a "cloud:" revision) in any state.
  const jobs = await db.cutRenderJob.findMany({
    where: {
      userId,
      kind: "preview",
      projectId: { in: missing.map((r) => r.id) },
      OR: [
        { state: { in: LIVE_STATES } },
        { spec: { path: ["revision"], string_starts_with: "cloud:" } },
      ],
    },
    select: { projectId: true, state: true, spec: true },
  });
  const busy = new Set(
    jobs.filter((j) => LIVE_STATES.includes(j.state)).map((j) => j.projectId),
  );
  const tried = new Set(
    jobs.map((j) => `${j.projectId} ${revisionOf(j.spec)}`),
  );
  const due = missing
    .filter((r) => !busy.has(r.id) && !tried.has(`${r.id} cloud:${r.version}`))
    .slice(0, CARD_BACKFILL_MAX);

  // One at a time, each on its own: a project that fails to queue leaves the
  // rest to theirs.
  for (const row of due) {
    await render(userId, row.id).catch((error: unknown) => {
      console.error(`card backfill failed for ${row.id}`, error);
    });
  }
}
