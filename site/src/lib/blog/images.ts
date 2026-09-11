// Every image on the blog is encoded here, once, to a fixed size and format,
// and named by its bytes. The header and thumbnail crops match the boxes the
// pages draw them in; an inline image keeps its shape under a width cap.
import { createHash } from "node:crypto";
import sharp from "sharp";

import { putObject } from "@/cut/server/cloud/r2";
import { blogImageKey, blogImageUrl } from "@/lib/blog/keys";

export type BlogImageKind = "header" | "thumbnail" | "inline";

export const BLOG_IMAGE_SIZES: Record<BlogImageKind, { width: number; height?: number }> = {
  header: { width: 1600, height: 900 },
  thumbnail: { width: 800, height: 500 },
  inline: { width: 1600 },
};

// AVIF at a quality that keeps a photographic header around 100 KB. The effort
// stays low because this runs inside a request.
const AVIF_QUALITY = 55;
const AVIF_EFFORT = 4;

export type EncodedBlogImage = { bytes: Buffer; width: number; height: number; sha256: string };

export async function encodeBlogImage(source: Buffer, kind: BlogImageKind): Promise<EncodedBlogImage> {
  const size = BLOG_IMAGE_SIZES[kind];
  const pipeline = sharp(source, { failOn: "none" }).rotate();
  const resized = size.height
    ? pipeline.resize(size.width, size.height, { fit: "cover", position: "attention" })
    : pipeline.resize({ width: size.width, withoutEnlargement: true });
  const { data, info } = await resized
    .avif({ quality: AVIF_QUALITY, effort: AVIF_EFFORT })
    .toBuffer({ resolveWithObject: true });
  return {
    bytes: data,
    width: info.width,
    height: info.height,
    sha256: createHash("sha256").update(data).digest("hex"),
  };
}

export type StoredBlogImage = { key: string; url: string; width: number; height: number };

// Encodes and writes the image under its own hash; the caller sets it on the row.
export async function storeBlogImage(postId: string, source: Buffer, kind: BlogImageKind): Promise<StoredBlogImage> {
  const encoded = await encodeBlogImage(source, kind);
  const key = blogImageKey(postId, encoded.sha256);
  await putObject(key, encoded.bytes, "image/avif");
  return { key, url: blogImageUrl(key), width: encoded.width, height: encoded.height };
}
