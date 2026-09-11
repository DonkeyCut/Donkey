import { NextResponse } from "next/server";
import { z } from "zod";

import { adminPost } from "@/lib/blog/admin";
import { readBody } from "@/lib/blog/read";
import { revalidateBlog } from "@/lib/blog/revalidate";
import { notFoundResponse, withSuperUser } from "@/lib/donkey-api-auth";
import { prisma } from "@/lib/prisma";

type Params = { params: Promise<{ id: string }> };
const idSchema = z.string().trim().min(1);

// Back to a draft. The page answers 404 from the next request on; the date is
// kept so republishing lands the post where it was.
export const POST = withSuperUser(async (_request, { params }: Params) => {
  const id = idSchema.safeParse((await params).id);
  if (!id.success) return notFoundResponse();
  const existing = await prisma.blogPost.findUnique({ select: { id: true }, where: { id: id.data } });
  if (!existing) return notFoundResponse();
  const row = await prisma.blogPost.update({ where: { id: id.data }, data: { status: "DRAFT" } });
  revalidateBlog([row.slug]);
  return NextResponse.json({ post: { ...adminPost(row), body: await readBody(row.id) } });
});
