import { NextResponse } from "next/server";
import { z } from "zod";

import { invalidResponse, listHoldout } from "@/lib/config/experimentList";
import { withSuperUser } from "@/lib/donkey-api-auth";
import { prisma } from "@/lib/prisma";

// The accounts kept out of every experiment. A held-out account is never
// assigned, reads the plain configuration even where it holds a row, and is
// left out of every result.

export const GET = withSuperUser(async () => {
  return NextResponse.json({ holdout: await listHoldout() });
});

const postSchema = z
  .object({
    email: z.email(),
    note: z.string().trim().max(200).nullable(),
  })
  .strict();

export const POST = withSuperUser(async (request) => {
  const parsed = postSchema.safeParse(await request.json());
  if (!parsed.success) return invalidResponse(parsed.error.issues);
  const user = await prisma.user.findUnique({ where: { email: parsed.data.email }, select: { id: true } });
  if (!user) return invalidResponse([{ path: ["email"], message: "No account has this email." }]);
  await prisma.experimentHoldout.upsert({
    where: { userId: user.id },
    create: { userId: user.id, note: parsed.data.note, actorUserId: request.donkey.userId },
    update: { note: parsed.data.note, actorUserId: request.donkey.userId },
  });
  return NextResponse.json({ holdout: await listHoldout() });
});

const deleteSchema = z.object({ userId: z.string().min(1) }).strict();

export const DELETE = withSuperUser(async (request) => {
  const parsed = deleteSchema.safeParse(await request.json());
  if (!parsed.success) return invalidResponse(parsed.error.issues);
  await prisma.experimentHoldout.deleteMany({ where: { userId: parsed.data.userId } });
  return NextResponse.json({ holdout: await listHoldout() });
});
