import { NextResponse } from "next/server";
import { z } from "zod";

import { adminPost } from "@/lib/blog/admin";
import { readBody } from "@/lib/blog/read";
import { revalidateBlogNow } from "@/lib/blog/revalidate";
import { notFoundResponse, withSuperUser } from "@/lib/donkey-api-auth";
import { prisma } from "@/lib/prisma";

type Params = { params: Promise<{ id: string }> };
const idSchema = z.string().trim().min(1);

// Publishing puts the post on the site as it is, dated now if the editor
// left the date empty; a date in the future is the one thing it refuses. One
// featured post at a time: featuring this one clears the others.
export const POST = withSuperUser(async (_request, { params }: Params) => {
  const id = idSchema.safeParse((await params).id);
  if (!id.success) return notFoundResponse();
  const existing = await prisma.blogPost.findUnique({ where: { id: id.data } });
  if (!existing) return notFoundResponse();
  if (existing.publishedAt && existing.publishedAt.getTime() > Date.now()) {
    return NextResponse.json(
      { error: "Not ready to publish", issues: [{ path: "publishedAt", message: "The publish date cannot be in the future." }] },
      { status: 400 },
    );
  }
  const body = await readBody(existing.id);
  const [row] = await prisma.$transaction([
    prisma.blogPost.update({
      where: { id: id.data },
      data: { status: "PUBLISHED", publishedAt: existing.publishedAt ?? new Date() },
    }),
    ...(existing.featured
      ? [prisma.blogPost.updateMany({ where: { featured: true, id: { not: id.data } }, data: { featured: false } })]
      : []),
  ]);
  await revalidateBlogNow([row.slug]);
  return NextResponse.json({ post: { ...adminPost(row), body } });
});
