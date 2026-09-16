// A project's agent write lease: one job that edits the document at a time.
// The queued or running row is the lease itself, so a chat turn and a command
// batch on the same project never race through the versioned PUT.
import type { Prisma } from "@/generated/prisma/client";
import { prisma } from "@/lib/prisma";
import { err } from "./util";
import { wakeRenderWorker } from "./wake";

/** The job kinds that hold the lease. An import that adopts its files into
 * the document (spec.adopt) writes the document too, so it holds the lease
 * against turns and batches; adopting imports run alongside each other and
 * merge through a retry in the worker. */
export const LEASE_KINDS = ["agent_turn", "commands"];

/** A live import that will write the document, if any. */
export async function liveAdoptingImport(userId: string, projectId: string): Promise<{ id: string } | null> {
  const rows = await prisma.cutRenderJob.findMany({
    where: { userId, projectId, kind: "import_url", state: { in: ["queued", "running"] } },
    select: { id: true, spec: true },
  });
  return rows.find((r) => Boolean((r.spec as { adopt?: unknown } | null)?.adopt)) ?? null;
}

/** The live lease holders on a project, oldest first. A read-only command
 * batch never saves, so it holds nothing. */
async function liveLeaseRows(userId: string, projectId: string): Promise<{ id: string }[]> {
  const rows = await prisma.cutRenderJob.findMany({
    where: { userId, projectId, kind: { in: LEASE_KINDS }, state: { in: ["queued", "running"] } },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    select: { id: true, spec: true },
  });
  return rows.filter((r) => !(r.spec as { readOnly?: boolean } | null)?.readOnly).map((r) => ({ id: r.id }));
}

/** A live turn or batch holding the lease, if any. */
export async function liveLeaseHolder(userId: string, projectId: string): Promise<{ id: string } | null> {
  return (await liveLeaseRows(userId, projectId))[0] ?? null;
}

/** Create the row, then keep it only if it is the oldest live lease holder for
 * the project. Two concurrent queues both create, both re-check, and exactly
 * one — the older row — survives. Returns the 409 for the loser. */
export async function queueLeasedJob(
  userId: string,
  projectId: string,
  kind: (typeof LEASE_KINDS)[number],
  spec: Prisma.InputJsonValue
): Promise<{ id: string } | Response> {
  const row = await prisma.cutRenderJob.create({ data: { userId, projectId, kind, spec } });
  const oldest = await liveLeaseHolder(userId, projectId);
  if (oldest && oldest.id !== row.id) {
    await prisma.cutRenderJob.delete({ where: { id: row.id } }).catch(() => {});
    return err("Another edit is already running for this project. Wait for it to finish.", 409);
  }
  if (await liveAdoptingImport(userId, projectId)) {
    await prisma.cutRenderJob.delete({ where: { id: row.id } }).catch(() => {});
    return err("An import is still landing in this project. Wait for it to finish, then edit.", 409);
  }
  wakeRenderWorker();
  return { id: row.id };
}
