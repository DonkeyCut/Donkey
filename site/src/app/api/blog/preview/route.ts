import { draftMode } from "next/headers";
import { NextResponse } from "next/server";
import { z } from "zod";

import { blogPath } from "@/lib/blog/keys";
import { notFoundResponse, withSuperUser } from "@/lib/donkey-api-auth";
import { prisma } from "@/lib/prisma";

const idSchema = z.string().trim().min(1);

// The su editor's Preview button lands here on the apex host, because the
// Draft Mode cookie is host-only. Draft Mode makes the blog's cached reads run
// fresh for this browser and include drafts; everyone else keeps the cache.
export const GET = withSuperUser(async (request) => {
  const id = idSchema.safeParse(request.nextUrl.searchParams.get("id"));
  if (!id.success) return notFoundResponse();
  const post = await prisma.blogPost.findUnique({ select: { slug: true }, where: { id: id.data } });
  if (!post) return notFoundResponse();
  (await draftMode()).enable();
  return NextResponse.redirect(new URL(blogPath(post.slug), request.url));
});
