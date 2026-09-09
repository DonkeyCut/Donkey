import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { getGlobalSetting } from "@/lib/config/effective";

export const sceneLeaseSchema = z.object({ owner: z.string().uuid(), release: z.boolean().optional() });

export async function cloudSceneLease(userId: string, projectId: string, req: Request): Promise<Response> {
  if (!(await prisma.cutProject.findFirst({ where: { id: projectId, userId }, select: { id: true } }))) return new Response(null, { status: 404 });
  const parsed = sceneLeaseSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return new Response(null, { status: 400 });
  const { owner, release } = parsed.data;
  const { sceneLeaseMs } = await getGlobalSetting("chatRuntime");
  const id = `scene-lease-${projectId}`;
  if (release) {
    await prisma.cutRenderJob.deleteMany({ where: { id, userId, outName: owner, state: "held" } });
    return Response.json({ acquired: false });
  }
  await prisma.cutRenderJob.createMany({
    data: [{ id, userId, projectId, kind: "scene_lease", state: "held", spec: {}, outName: owner }],
    skipDuplicates: true,
  });
  const { count } = await prisma.cutRenderJob.updateMany({
    where: { id, userId, state: "held", OR: [{ outName: owner }, { updatedAt: { lt: new Date(Date.now() - sceneLeaseMs) } }] },
    data: { outName: owner, updatedAt: new Date() },
  });
  return Response.json({ acquired: count === 1, leaseMs: sceneLeaseMs });
}
