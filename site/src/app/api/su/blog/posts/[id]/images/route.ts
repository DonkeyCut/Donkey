import { NextResponse } from "next/server";
import { z } from "zod";

import { del, getObject, putObject } from "@/cut/server/cloud/r2";
import { adminPost } from "@/lib/blog/admin";
import { encodeBlogImage } from "@/lib/blog/images";
import { blogImageKey, blogImageUrl, blogPrefix } from "@/lib/blog/keys";
import { revalidateBlogLater } from "@/lib/blog/revalidate";
import { invalidResponse } from "@/lib/config/experimentList";
import { notFoundResponse, withSuperUser } from "@/lib/donkey-api-auth";
import { prisma } from "@/lib/prisma";

type Params = { params: Promise<{ id: string }> };
const idSchema = z.string().trim().min(1);

const bodySchema = z
  .object({
    uploadKey: z.string().min(1),
    kind: z.enum(["header", "thumbnail", "inline"]),
  })
  .strict();

// Turns an upload into the image the pages serve: read from the scratch key,
// encoded to the kind's size, written under its own hash, and the scratch
// deleted. A header or thumbnail is also set on the row.
export const POST = withSuperUser(async (request, { params }: Params) => {
  const id = idSchema.safeParse((await params).id);
  if (!id.success) return notFoundResponse();
  const parsed = bodySchema.safeParse(await request.json());
  if (!parsed.success) return invalidResponse(parsed.error.issues);
  const existing = await prisma.blogPost.findUnique({ select: { id: true, slug: true }, where: { id: id.data } });
  if (!existing) return notFoundResponse();
  const { uploadKey, kind } = parsed.data;
  // A route reads only under its own prefix, so a key from the body cannot
  // reach into another post or another user's media.
  if (!uploadKey.startsWith(`${blogPrefix(existing.id)}uploads/`)) {
    return invalidResponse([{ path: ["uploadKey"], message: "Not an upload for this post." }]);
  }
  const upload = await getObject(uploadKey);
  if (!upload) return invalidResponse([{ path: ["uploadKey"], message: "The upload was not found." }]);

  const encoded = await encodeBlogImage(upload.bytes, kind);
  const key = blogImageKey(existing.id, encoded.sha256);
  await putObject(key, encoded.bytes, "image/avif");
  await del([uploadKey]);

  const image = { key, url: blogImageUrl(key), width: encoded.width, height: encoded.height };
  if (kind === "inline") return NextResponse.json({ image });

  const row = await prisma.blogPost.update({
    where: { id: existing.id },
    data: kind === "header" ? { headerKey: key } : { thumbnailKey: key },
  });
  revalidateBlogLater([row.slug]);
  return NextResponse.json({ image, post: adminPost(row) });
});
