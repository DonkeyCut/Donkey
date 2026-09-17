// A project's agent write lease: one job that edits the document at a time.
// The queued or running row is the lease itself, so a chat turn and a command
// batch on the same project never race through the versioned PUT.
import type { Prisma } from "@/generated/prisma/client";
import { prisma } from "@/lib/prisma";
import { err } from "./util";
import { wakeRenderWorker } from "./wake";

/** The job kinds that hold the lease. An import only lands files; the batch
 * that adopts them into the document is a commands job of its own. */
export const LEASE_KINDS = ["agent_turn", "commands"];

/** The live lease holders on a project, oldest first. A read-only command
 * batch never saves, so it holds nothing. */
async function liveLeaseRows(userId: string, projectId: string, kinds: string[]): Promise<{ id: string }[]> {
  const rows = await prisma.cutRenderJob.findMany({
    where: { userId, projectId, kind: { in: kinds }, state: { in: ["queued", "running"] } },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    select: { id: true, spec: true },
  });
  return rows.filter((r) => !(r.spec as { readOnly?: boolean } | null)?.readOnly).map((r) => ({ id: r.id }));
}

/** A live turn or batch holding the lease, if any. */
export async function liveLeaseHolder(userId: string, projectId: string, kinds: string[] = LEASE_KINDS): Promise<{ id: string } | null> {
  return (await liveLeaseRows(userId, projectId, kinds))[0] ?? null;
}

/** Create the row, then keep it only if no older live row of the kinds it
 * contends with holds the lease. Two concurrent queues both create, both
 * re-check, and exactly one — the older row — survives. Returns the 409 for
 * the loser. Command batches contend with chat turns only: the editor in the
 * card runs its batches one after another, so they queue behind each other. */
export async function queueLeasedJob(
  userId: string,
  projectId: string,
  kind: (typeof LEASE_KINDS)[number],
  spec: Prisma.InputJsonValue,
  opts: { wake?: boolean; contendsWith?: string[] } = {}
): Promise<{ id: string } | Response> {
  const row = await prisma.cutRenderJob.create({ data: { userId, projectId, kind, spec } });
  const oldest = await liveLeaseHolder(userId, projectId, opts.contendsWith ?? LEASE_KINDS);
  if (oldest && oldest.id !== row.id) {
    await prisma.cutRenderJob.delete({ where: { id: row.id } }).catch(() => {});
    return err("Another edit is already running for this project. Wait for it to finish.", 409);
  }
  if (opts.wake !== false) wakeRenderWorker();
  return { id: row.id };
}
