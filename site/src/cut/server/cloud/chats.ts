// AI chat threads for cloud projects. The client owns the thread shape (the
// same slimmed payload it keeps in localStorage) and syncs it here so a cloud
// project's chats follow the account across devices; the server stores each
// thread as an opaque JSON blob keyed by (projectId, thread id).
import { prisma } from "@/lib/prisma";
import type { Prisma } from "@/generated/prisma/client";

import { caught, err } from "./util";

// Well above a slimmed thread (data-URL frames are stripped client-side), well
// below anything that could hurt the database.
const MAX_THREAD_BYTES = 4_000_000;

/** Polling reads row versions; transcript bodies are fetched only after a change. */
export async function listChatThreads(
  userId: string, projectId: string, req: Request,
  headersFor?: (updatedAt: Date | undefined) => Record<string, string>,
) {
  const query = new URL(req.url).searchParams;
  const where = { userId, projectId, ...(query.has("id") ? { id: query.get("id")! } : {}) };
  if (query.has("revisions")) {
    const rows = await prisma.cutChatThread.findMany({ where, orderBy: { updatedAt: "desc" }, select: { id: true, updatedAt: true } });
    return Response.json(rows.map((row) => ({ id: row.id, revision: row.updatedAt.toISOString() })), { headers: headersFor?.(rows[0]?.updatedAt) });
  }
  const rows = await prisma.cutChatThread.findMany({
    where, orderBy: { updatedAt: "desc" }, select: { data: true, updatedAt: true },
  });
  return Response.json(rows.map((row) => row.data), { headers: headersFor?.(rows[0]?.updatedAt) });
}

const ownsProject = (userId: string, id: string) =>
  prisma.cutProject.findFirst({ where: { id, userId }, select: { id: true } });

export const chatsCloud = {
  async list(userId: string, projectId: string, req: Request) {
    if (!(await ownsProject(userId, projectId))) return err("Project not found.", 404);
    return listChatThreads(userId, projectId, req);
  },

  async put(userId: string, projectId: string, chatId: string, req: Request) {
    try {
      if (!(await ownsProject(userId, projectId))) return err("Project not found.", 404);
      const text = await req.text();
      if (text.length > MAX_THREAD_BYTES) return err("Chat thread too large.", 413);
      const body = JSON.parse(text) as Record<string, unknown>;
      const data = { ...body, id: chatId } as Prisma.InputJsonValue;
      const stored = await prisma.cutChatThread.findUnique({ where: { projectId_id: { projectId, id: chatId } } });
      const previous = stored?.data as { updatedAt?: number; deleted?: boolean } | null;
      if (previous?.deleted) return err("This conversation was deleted.", 410);
      if (stored && typeof body.updatedAt === "number" && body.updatedAt <= (previous?.updatedAt ?? 0))
        return Response.json({ ok: true });
      if (stored) {
        const { count } = await prisma.cutChatThread.updateMany({
          where: { projectId, id: chatId, userId, updatedAt: stored.updatedAt }, data: { data },
        });
        if (!count) return err("The conversation changed. Reload it before saving.", 409);
      } else {
        const { count } = await prisma.cutChatThread.createMany({ data: [{ projectId, id: chatId, userId, data }], skipDuplicates: true });
        if (!count) return err("The conversation changed. Reload it before saving.", 409);
      }
      return Response.json({ ok: true });
    } catch (e) {
      return caught(e, "Could not save chat thread.");
    }
  },

  async remove(userId: string, projectId: string, chatId: string) {
    try {
      if (!(await ownsProject(userId, projectId))) return err("Project not found.", 404);
      const data = { id: chatId, deleted: true, updatedAt: Date.now() };
      await prisma.cutChatThread.upsert({
        where: { projectId_id: { projectId, id: chatId } },
        create: { userId, projectId, id: chatId, data },
        update: { data },
      });
      return Response.json({ ok: true });
    } catch (e) {
      return caught(e, "Could not delete chat thread.");
    }
  },
};
