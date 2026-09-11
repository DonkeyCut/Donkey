import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import { z } from "zod";

import { presignPut } from "@/cut/server/cloud/r2";
import { blogUploadKey } from "@/lib/blog/keys";
import { invalidResponse } from "@/lib/config/experimentList";
import { notFoundResponse, withSuperUser } from "@/lib/donkey-api-auth";
import { prisma } from "@/lib/prisma";

type Params = { params: Promise<{ id: string }> };
const idSchema = z.string().trim().min(1);

// What the encoder can read. HEIC needs a decoder the bundled sharp lacks.
export const BLOG_UPLOAD_MIMES = new Set(["image/png", "image/jpeg", "image/webp", "image/gif", "image/avif"]);
export const BLOG_UPLOAD_MAX_BYTES = 25 * 1024 * 1024;

const bodySchema = z
  .object({
    mime: z.string().refine((mime) => BLOG_UPLOAD_MIMES.has(mime), "Not an image the blog can take."),
    bytes: z.number().int().positive().max(BLOG_UPLOAD_MAX_BYTES, "Keep images under 25 MB."),
  })
  .strict();

// Image bytes never ride a request body here (the platform caps it at the
// edge). The browser gets a one-hour PUT to a scratch key under the post, then
// names that key to the images route, which encodes and deletes it.
export const POST = withSuperUser(async (request, { params }: Params) => {
  const id = idSchema.safeParse((await params).id);
  if (!id.success) return notFoundResponse();
  const parsed = bodySchema.safeParse(await request.json());
  if (!parsed.success) return invalidResponse(parsed.error.issues);
  const existing = await prisma.blogPost.findUnique({ select: { id: true }, where: { id: id.data } });
  if (!existing) return notFoundResponse();
  const key = blogUploadKey(existing.id, randomUUID());
  return NextResponse.json({ key, putUrl: await presignPut(key, parsed.data.mime, parsed.data.bytes) });
});
