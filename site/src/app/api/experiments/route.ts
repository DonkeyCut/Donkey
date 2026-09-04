import { NextResponse } from "next/server";

import { invalidResponse, listExperiments } from "@/lib/config/experimentList";
import { experimentSchema } from "@/lib/config/experiment";
import { withSuperUser } from "@/lib/donkey-api-auth";
import { prisma } from "@/lib/prisma";
import type { Prisma } from "@/generated/prisma/client";

export const GET = withSuperUser(async () => {
  return NextResponse.json({ experiments: await listExperiments() });
});

// A new experiment starts as a draft; starting it is a status change.
export const POST = withSuperUser(async (request) => {
  const parsed = experimentSchema.safeParse(await request.json());
  if (!parsed.success) return invalidResponse(parsed.error.issues);
  const input = parsed.data;
  const taken = await prisma.experiment.findUnique({ where: { key: input.key }, select: { id: true } });
  if (taken) {
    return invalidResponse([{ path: ["key"], message: "An experiment with this key exists." }]);
  }
  await prisma.experiment.create({
    data: {
      key: input.key,
      name: input.name,
      description: input.description,
      variants: input.variants as Prisma.InputJsonValue,
      audience: input.audience as Prisma.InputJsonValue,
      percent: input.percent,
      metrics: input.metrics as Prisma.InputJsonValue,
      actorUserId: request.donkey.userId,
    },
  });
  return NextResponse.json({ experiments: await listExperiments() });
});
