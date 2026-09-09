import { SETTINGS } from "@/lib/config/registry";
import { z } from "zod";
import { projectFileRevision } from "../projects";

const globalLeases = globalThis as unknown as { __cutSceneLeases?: Map<string, { owner: string; until: number }> };
const leases = (globalLeases.__cutSceneLeases ??= new Map<string, { owner: string; until: number }>());
const schema = z.object({ owner: z.string().uuid(), release: z.boolean().optional(), leaseMs: SETTINGS.chatRuntime.schema.shape.sceneLeaseMs });

export async function localSceneLease(projectId: string, req: Request): Promise<Response> {
  if (!(await projectFileRevision(projectId))) return new Response(null, { status: 404 });
  const parsed = schema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return new Response(null, { status: 400 });
  const now = Date.now();
  for (const [id, lease] of leases) if (lease.until <= now) leases.delete(id);
  const current = leases.get(projectId);
  if (parsed.data.release) {
    if (current?.owner === parsed.data.owner) leases.delete(projectId);
    return Response.json({ acquired: false });
  }
  if (current && current.owner !== parsed.data.owner) return Response.json({ acquired: false });
  leases.set(projectId, { owner: parsed.data.owner, until: now + parsed.data.leaseMs });
  return Response.json({ acquired: true });
}
