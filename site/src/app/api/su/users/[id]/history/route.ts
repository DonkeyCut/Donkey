import { NextResponse } from "next/server";
import { z } from "zod";

import { notFoundResponse, withSuperUser } from "@/lib/donkey-api-auth";
import { readUserHistory } from "@/lib/marketing/userHistory";
import { prisma } from "@/lib/prisma";

type Params = { params: Promise<{ id: string }> };
const idSchema = z.string().trim().min(1);

// One account's offers, grants, mail and storage, for the operator writing
// to the person.
export const GET = withSuperUser(async (_request, { params }: Params) => {
  const id = idSchema.safeParse((await params).id);
  if (!id.success) return notFoundResponse();
  const user = await prisma.user.findUnique({ select: { id: true }, where: { id: id.data } });
  if (!user) return notFoundResponse();
  return NextResponse.json(await readUserHistory(user.id));
});
