// One chat turn as a durable job. The page (or an API caller) posts the
// thread's messages; the worker container claims the row, runs the headless
// turn against the project doc, and settles the row with the reply. The
// queued/running row doubles as the project's agent write lease — one turn at
// a time per project — and the generic /jobs/:jobId route serves the poll.
import type { Prisma } from "@/generated/prisma/client";
import { prisma } from "@/lib/prisma";
import { getProject } from "./projects";
import { caught, err } from "./util";
import { wakeRenderWorker } from "./wake";

// Well above a slimmed thread, well below anything that could hurt the row.
const MAX_TURN_BYTES = 1_000_000;

export interface AgentTurnSpec {
  threadId: string;
  messages: unknown[];
  model?: string;
}

export const turnsCloud = {
  async queue(userId: string, projectId: string, req: Request) {
    try {
      if (!(await getProject(userId, projectId))) return err("Project not found.", 404);
      const text = await req.text();
      if (text.length > MAX_TURN_BYTES) return err("Turn too large.", 413);
      const body = JSON.parse(text) as Partial<AgentTurnSpec>;
      const threadId = typeof body.threadId === "string" ? body.threadId.trim() : "";
      if (!threadId || !Array.isArray(body.messages) || body.messages.length === 0)
        return err("threadId and messages are required.", 400);
      // The runner reads messages as UIMessages; a malformed shape must be
      // refused here, ahead of the model spend it would otherwise ride along
      // to before crashing the record step.
      const wellFormed = body.messages.every(
        (m) =>
          !!m &&
          typeof m === "object" &&
          typeof (m as { id?: unknown }).id === "string" &&
          typeof (m as { role?: unknown }).role === "string" &&
          Array.isArray((m as { parts?: unknown }).parts)
      );
      if (!wellFormed) return err("Every message needs id, role, and a parts array.", 400);
      const spec: AgentTurnSpec = {
        threadId,
        messages: body.messages,
        ...(typeof body.model === "string" && body.model ? { model: body.model } : {}),
      };
      // The write lease, race-safely: create first, then keep the row only if
      // it is the oldest live turn for the project. Two concurrent queues both
      // create, both re-check, and exactly one — the older row — survives.
      const row = await prisma.cutRenderJob.create({
        data: {
          userId,
          projectId,
          kind: "agent_turn",
          spec: spec as unknown as Prisma.InputJsonValue,
        },
      });
      const oldest = await prisma.cutRenderJob.findFirst({
        where: { userId, projectId, kind: "agent_turn", state: { in: ["queued", "running"] } },
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
        select: { id: true },
      });
      if (oldest && oldest.id !== row.id) {
        await prisma.cutRenderJob.delete({ where: { id: row.id } }).catch(() => {});
        return err("A turn is already running for this project.", 409);
      }
      wakeRenderWorker();
      return Response.json({ jobId: row.id });
    } catch (e) {
      return caught(e, "Could not start the turn.");
    }
  },

  async cancel(userId: string, jobId: string) {
    try {
      // The worker honors "canceled" between stream reads; a queued row is
      // simply never claimed.
      await prisma.cutRenderJob.updateMany({
        where: { id: jobId, userId, kind: "agent_turn", state: { in: ["queued", "running"] } },
        data: { state: "canceled" },
      });
      return Response.json({ ok: true });
    } catch (e) {
      return caught(e, "Could not cancel the turn.");
    }
  },
};
