// One chat turn as a durable job. The page (or an API caller) posts the
// thread's messages; the worker container claims the row, runs the headless
// turn against the project doc, and settles the row with the reply. The
// queued/running row holds the project's agent write lease (lease.ts), and
// the generic /jobs/:jobId route serves the poll.
import type { Prisma } from "@/generated/prisma/client";
import { prisma } from "@/lib/prisma";
import { cutLimitsFor, liveJobCheck } from "./limits";
import { queueLeasedJob } from "./lease";
import { getProject } from "./projects";
import { caught, err } from "./util";

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
      const capped = await liveJobCheck(userId);
      if (capped) return capped;
      // Turns run one per project; across projects an account holds its
      // tier's count at once, so opening projects by the hundred earns a wait.
      const { liveTurns: maxTurns } = await cutLimitsFor(userId);
      if (maxTurns !== null) {
        const liveTurns = await prisma.cutRenderJob.count({
          where: { userId, kind: "agent_turn", state: { in: ["queued", "running"] } },
        });
        if (liveTurns >= maxTurns)
          return err("Too many turns are running on this account. Wait for one to finish.", 429);
      }
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
      const row = await queueLeasedJob(userId, projectId, "agent_turn", spec as unknown as Prisma.InputJsonValue);
      if (row instanceof Response) return row;
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
