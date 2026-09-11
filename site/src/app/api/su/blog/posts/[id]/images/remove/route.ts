import { NextResponse } from "next/server";
import { z } from "zod";

import { adminPost } from "@/lib/blog/admin";
import { revalidateBlog } from "@/lib/blog/revalidate";
import { invalidResponse } from "@/lib/config/experimentList";
import { notFoundResponse, withSuperUser } from "@/lib/donkey-api-auth";
import { prisma } from "@/lib/prisma";

type Params = { params: Promise<{ id: string }> };
const idSchema = z.string().trim().min(1);
const bodySchema = z.object({ kind: z.enum(["header", "thumbnail"]) }).strict();

// Clears the header or thumbnail from the row. The object stays under the
// post's prefix, content-addressed, and goes when the post does.
export const POST = withSuperUser(async (request, { params }: Params) => {
  const id = idSchema.safeParse((await params).id);
  if (!id.success) return notFoundResponse();
  const parsed = bodySchema.safeParse(await request.json());
  if (!parsed.success) return invalidResponse(parsed.error.issues);
  const existing = await prisma.blogPost.findUnique({ select: { id: true }, where: { id: id.data } });
  if (!existing) return notFoundResponse();
  const row = await prisma.blogPost.update({
    where: { id: existing.id },
    data: parsed.data.kind === "header" ? { headerKey: null, headerAlt: null, headerFocus: null } : { thumbnailKey: null },
  });
  revalidateBlog([row.slug]);
  return NextResponse.json({ post: adminPost(row) });
});
