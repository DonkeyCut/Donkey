// Every image on the blog is encoded here, once, to a fixed format under a
// width cap, and named by its bytes. The picture keeps its shape: the pages
// crop the header and the thumbnail to their boxes with the focus the editor
// set, so anything in the picture can be brought into frame later.
import { createHash } from "node:crypto";
import sharp from "sharp";

import { putObject } from "@/cut/server/cloud/r2";
import { blogImageKey, blogImageUrl } from "@/lib/blog/keys";

export type BlogImageKind = "header" | "thumbnail" | "inline";

export const BLOG_IMAGE_WIDTHS: Record<BlogImageKind, number> = {
  header: 1600,
  thumbnail: 1000,
  inline: 1600,
};

// AVIF at a quality that keeps a photographic header around 100 KB. The effort
// stays low because this runs inside a request.
const AVIF_QUALITY = 55;
const AVIF_EFFORT = 4;

export type EncodedBlogImage = { bytes: Buffer; width: number; height: number; sha256: string };

export async function encodeBlogImage(source: Buffer, kind: BlogImageKind): Promise<EncodedBlogImage> {
  const { data, info } = await sharp(source, { failOn: "none" })
    .rotate()
    .resize({ width: BLOG_IMAGE_WIDTHS[kind], withoutEnlargement: true })
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
