import { NextResponse } from "next/server";
import { z } from "zod";

import { findExperiment, invalidResponse, listExperiments } from "@/lib/config/experimentList";
import { parseVariants } from "@/lib/config/effective";
import { notFoundResponse, withSuperUser } from "@/lib/donkey-api-auth";
import { prisma } from "@/lib/prisma";

type Params = { params: Promise<{ id: string }> };

// An assignment written by hand: the account reads this variant from now on,
// whatever the audience and the hash say; a null variant holds the account
// out of this experiment. Manual rows are never counted in the results.
const putSchema = z
  .object({
    email: z.email(),
    variant: z.string().min(1).nullable(),
  })
  .strict();

export const PUT = withSuperUser(async (request, { params }: Params) => {
  const { id } = await params;
  const current = await findExperiment(id);
  if (!current) return notFoundResponse();
  const parsed = putSchema.safeParse(await request.json());
  if (!parsed.success) return invalidResponse(parsed.error.issues);
  const { email, variant } = parsed.data;
  if (variant !== null && !parseVariants(current.variants).some((v) => v.key === variant)) {
    return invalidResponse([{ path: ["variant"], message: `No variant "${variant}".` }]);
  }
  const user = await prisma.user.findUnique({ where: { email }, select: { id: true } });
  if (!user) return invalidResponse([{ path: ["email"], message: "No account has this email." }]);
  await prisma.experimentAssignment.upsert({
    where: { experimentId_userId: { experimentId: id, userId: user.id } },
    create: { experimentId: id, userId: user.id, variant, manual: true },
    update: { variant, manual: true },
  });
  return NextResponse.json({ experiments: await listExperiments() });
});

const deleteSchema = z.object({ userId: z.string().min(1) }).strict();

// Drops the row; the next read assigns the account afresh, if it is eligible.
export const DELETE = withSuperUser(async (request, { params }: Params) => {
  const { id } = await params;
  const current = await findExperiment(id);
  if (!current) return notFoundResponse();
  const parsed = deleteSchema.safeParse(await request.json());
  if (!parsed.success) return invalidResponse(parsed.error.issues);
  await prisma.experimentAssignment.deleteMany({ where: { experimentId: id, userId: parsed.data.userId } });
  return NextResponse.json({ experiments: await listExperiments() });
});
