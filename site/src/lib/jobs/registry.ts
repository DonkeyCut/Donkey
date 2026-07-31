import type { z } from "zod";

import type { Prisma } from "@/generated/prisma/client";
import { deleteUserJob } from "@/lib/jobs/delete-user";

// Thrown by an executor when the job can never succeed — the message lands on
// the job row as its error. Anything else thrown is transient: the claim is
// released and the queue redelivers.
export class JobFailure extends Error {}

export type JobKind = {
  // Validates a payload at creation time and again at execution time; a stored
  // payload that no longer parses is a permanent failure.
  payload: z.ZodType<unknown>;
  run: (payload: unknown) => Promise<Prisma.InputJsonValue>;
};

export function defineJob<S extends z.ZodType<unknown>>(
  payload: S,
  run: (payload: z.output<S>) => Promise<Prisma.InputJsonValue>,
): JobKind {
  return { payload, run: (raw) => run(payload.parse(raw)) };
}

export const jobKinds: Record<string, JobKind> = {
  "delete-user": deleteUserJob,
};
