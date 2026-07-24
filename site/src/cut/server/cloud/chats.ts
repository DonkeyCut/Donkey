// AI chat threads for cloud projects. The client owns the thread shape (the
// same slimmed payload it keeps in localStorage) and syncs it here so a cloud
// project's chats follow the account across devices; the server stores each
// thread as an opaque JSON blob keyed by (projectId, thread id).
import { prisma } from "@/lib/prisma";
import type { Prisma } from "@/generated/prisma/client";
import { getProject } from "./projects";
import { caught, err } from "./util";

// Well above a slimmed thread (data-URL frames are stripped client-side), well
// below anything that could hurt the database.
const MAX_THREAD_BYTES = 4_000_000;

export const chatsCloud = {
  async list(userId: string, projectId: string) {
    if (!(await getProject(userId, projectId))) return err("Project not found.", 404);
    const rows = await prisma.cutChatThread.findMany({
      where: { userId, projectId },
      orderBy: { updatedAt: "desc" },
      select: { data: true },
    });
    return Response.json(rows.map((r) => r.data));
  },

  async put(userId: string, projectId: string, chatId: string, req: Request) {
    try {
      if (!(await getProject(userId, projectId))) return err("Project not found.", 404);
      const text = await req.text();
      if (text.length > MAX_THREAD_BYTES) return err("Chat thread too large.", 413);
      const body = JSON.parse(text) as Record<string, unknown>;
      const data = { ...body, id: chatId } as Prisma.InputJsonValue;
      await prisma.cutChatThread.upsert({
        where: { projectId_id: { projectId, id: chatId } },
        create: { projectId, id: chatId, userId, data },
        update: { data },
      });
      return Response.json({ ok: true });
    } catch (e) {
      return caught(e, "Could not save chat thread.");
    }
  },

  async remove(userId: string, projectId: string, chatId: string) {
    try {
      await prisma.cutChatThread.deleteMany({
        where: { userId, projectId, id: chatId },
      });
      return Response.json({ ok: true });
    } catch (e) {
      return caught(e, "Could not delete chat thread.");
    }
  },
};
