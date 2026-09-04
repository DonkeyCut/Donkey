import { NextResponse } from "next/server";
import { z } from "zod";

import { findExperiment, invalidResponse, listExperiments } from "@/lib/config/experimentList";
import type { Prisma } from "@/generated/prisma/client";
import {
  canTransition,
  experimentSchema,
  removedAssignedVariants,
  statusSchema,
  type ExperimentStatus,
} from "@/lib/config/experiment";
import { notFoundResponse, withSuperUser } from "@/lib/donkey-api-auth";
import { prisma } from "@/lib/prisma";

type Params = { params: Promise<{ id: string }> };

// The whole definition, replaced. Once accounts hold a variant its key stays;
// new variants may join.
export const PUT = withSuperUser(async (request, { params }: Params) => {
  const { id } = await params;
  const current = await findExperiment(id);
  if (!current) return notFoundResponse();
  const parsed = experimentSchema.safeParse(await request.json());
  if (!parsed.success) return invalidResponse(parsed.error.issues);
  const input = parsed.data;

  if (input.key !== current.key) {
    const taken = await prisma.experiment.findUnique({ where: { key: input.key }, select: { id: true } });
    if (taken) return invalidResponse([{ path: ["key"], message: "An experiment with this key exists." }]);
  }
  const assigned = await prisma.experimentAssignment.groupBy({
    by: ["variant"],
    where: { experimentId: id },
  });
  const removed = removedAssignedVariants(
    input,
    assigned.flatMap((a) => (a.variant === null ? [] : [a.variant])),
  );
  if (removed.length > 0) {
    return invalidResponse([
      { path: ["variants"], message: `Accounts hold ${removed.join(", ")}; those variants must stay.` },
    ]);
  }

  await prisma.experiment.update({
    where: { id },
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

const patchSchema = z.object({ status: statusSchema }).strict();

export const PATCH = withSuperUser(async (request, { params }: Params) => {
  const { id } = await params;
  const current = await findExperiment(id);
  if (!current) return notFoundResponse();
  const parsed = patchSchema.safeParse(await request.json());
  if (!parsed.success) return invalidResponse(parsed.error.issues);
  const from = current.status as ExperimentStatus;
  const to = parsed.data.status;
  if (!canTransition(from, to)) {
    return invalidResponse([{ path: ["status"], message: `Cannot go from ${from} to ${to}.` }]);
  }
  const now = new Date();
  await prisma.experiment.update({
    where: { id },
    data: {
      status: to,
      actorUserId: request.donkey.userId,
      ...(to === "running" && !current.startedAt ? { startedAt: now } : {}),
      ...(to === "ended" ? { endedAt: now } : {}),
    },
  });
  return NextResponse.json({ experiments: await listExperiments() });
});

// A draft nobody was assigned to can go; anything that ran keeps its record.
export const DELETE = withSuperUser(async (_request, { params }: Params) => {
  const { id } = await params;
  const current = await findExperiment(id);
  if (!current) return notFoundResponse();
  if (current.status !== "draft") {
    return invalidResponse([{ path: ["status"], message: "Only a draft can be deleted." }]);
  }
  await prisma.experiment.delete({ where: { id } });
  return NextResponse.json({ experiments: await listExperiments() });
});
