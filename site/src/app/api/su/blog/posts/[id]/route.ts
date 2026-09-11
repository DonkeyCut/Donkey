import { NextResponse } from "next/server";
import { z } from "zod";

import { deletePrefix, putObject } from "@/cut/server/cloud/r2";
import { Prisma } from "@/generated/prisma/client";
import { adminPost } from "@/lib/blog/admin";
import { blogBodyKey, blogPrefix } from "@/lib/blog/keys";
import { readBody } from "@/lib/blog/read";
import { revalidateBlog } from "@/lib/blog/revalidate";
import { blogPostInputSchema } from "@/lib/blog/schema";
import { invalidResponse } from "@/lib/config/experimentList";
import { notFoundResponse, withSuperUser } from "@/lib/donkey-api-auth";
import { prisma } from "@/lib/prisma";

type Params = { params: Promise<{ id: string }> };
const idSchema = z.string().trim().min(1);

export const GET = withSuperUser(async (_request, { params }: Params) => {
  const id = idSchema.safeParse((await params).id);
  if (!id.success) return notFoundResponse();
  const row = await prisma.blogPost.findUnique({ where: { id: id.data } });
  if (!row) return notFoundResponse();
  return NextResponse.json({ post: { ...adminPost(row), body: await readBody(row.id) } });
});

// A save: the fields onto the row, the body into R2 when it changed. Both the
// old and the new slug are cleared from the cache, so a renamed post stops
// answering at its old address.
export const PUT = withSuperUser(async (request, { params }: Params) => {
  const id = idSchema.safeParse((await params).id);
  if (!id.success) return notFoundResponse();
  const parsed = blogPostInputSchema.safeParse(await request.json());
  if (!parsed.success) return invalidResponse(parsed.error.issues);
  const existing = await prisma.blogPost.findUnique({ where: { id: id.data } });
  if (!existing) return notFoundResponse();
  const input = parsed.data;

  const bodyChanged = input.body !== (await readBody(existing.id));
  if (bodyChanged) await putObject(blogBodyKey(existing.id), Buffer.from(input.body, "utf8"), "text/markdown");

  let row;
  try {
    row = await prisma.blogPost.update({
      where: { id: id.data },
      data: {
        slug: input.slug,
        title: input.title,
        excerpt: input.excerpt,
        summary: input.summary || null,
        tags: input.tags,
        keywords: input.keywords,
        featured: input.featured,
        publishedAt: input.publishedAt ? new Date(input.publishedAt) : null,
        revisedAt: input.revisedAt ? new Date(input.revisedAt) : null,
        headerAlt: input.headerAlt || null,
        headerFocus: input.headerFocus,
        seoTitle: input.seoTitle || null,
        canonicalUrl: input.canonicalUrl || null,
        noIndex: input.noIndex,
        ...(bodyChanged ? { bodyVersion: { increment: 1 } } : {}),
      },
    });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      return NextResponse.json(
        { error: "Invalid request", issues: [{ path: "slug", message: "Another post has that slug." }] },
        { status: 409 },
      );
    }
    throw error;
  }
  revalidateBlog([existing.slug, row.slug]);
  return NextResponse.json({ post: { ...adminPost(row), body: input.body } });
});

// Deleting a post removes its row and sweeps everything it owned in R2.
export const DELETE = withSuperUser(async (_request, { params }: Params) => {
  const id = idSchema.safeParse((await params).id);
  if (!id.success) return notFoundResponse();
  const existing = await prisma.blogPost.findUnique({ where: { id: id.data } });
  if (!existing) return notFoundResponse();
  await prisma.blogPost.delete({ where: { id: id.data } });
  await deletePrefix(blogPrefix(existing.id));
  revalidateBlog([existing.slug]);
  return NextResponse.json({ ok: true });
});
