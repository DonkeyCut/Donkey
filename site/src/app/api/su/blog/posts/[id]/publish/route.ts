import { NextResponse } from "next/server";
import { z } from "zod";

import { adminPost } from "@/lib/blog/admin";
import { readBody } from "@/lib/blog/read";
import { revalidateBlog } from "@/lib/blog/revalidate";
import { publishIssues } from "@/lib/blog/schema";
import { notFoundResponse, withSuperUser } from "@/lib/donkey-api-auth";
import { prisma } from "@/lib/prisma";

type Params = { params: Promise<{ id: string }> };
const idSchema = z.string().trim().min(1);

// Publishing holds the post to the full contract, then dates it if the editor
// left the date empty. One featured post at a time: featuring this one clears
// the others.
export const POST = withSuperUser(async (_request, { params }: Params) => {
  const id = idSchema.safeParse((await params).id);
  if (!id.success) return notFoundResponse();
  const existing = await prisma.blogPost.findUnique({ where: { id: id.data } });
  if (!existing) return notFoundResponse();
  const body = await readBody(existing.id);
  const issues = publishIssues({
    title: existing.title,
    excerpt: existing.excerpt,
    summary: existing.summary,
    headerKey: existing.headerKey,
    thumbnailKey: existing.thumbnailKey,
    publishedAt: existing.publishedAt?.toISOString() ?? null,
    body,
  });
  if (issues.length > 0) {
    return NextResponse.json({ error: "Not ready to publish", issues }, { status: 400 });
  }
  const [row] = await prisma.$transaction([
    prisma.blogPost.update({
      where: { id: id.data },
      data: { status: "PUBLISHED", publishedAt: existing.publishedAt ?? new Date() },
    }),
    ...(existing.featured
      ? [prisma.blogPost.updateMany({ where: { featured: true, id: { not: id.data } }, data: { featured: false } })]
      : []),
  ]);
  revalidateBlog([row.slug]);
  return NextResponse.json({ post: { ...adminPost(row), body } });
});
