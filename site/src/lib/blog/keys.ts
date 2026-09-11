// Where a blog post lives: the key scheme in R2, the public addresses on
// donkeycut.com, and the list's page size. Client-safe, so the su editor and
// the public pages build the same paths.
import { CUT_MEDIA_ORIGIN } from "@/cut/lib/hosts";

// Everything a post owns sits under this prefix, so a delete sweeps it whole.
// It is a sibling of the cut/ root the storage sweep walks, so the sweep never
// sees it.
export const BLOG_ROOT = "blog/";
export const blogPrefix = (postId: string) => `${BLOG_ROOT}${postId}/`;
export const blogBodyKey = (postId: string) => `${blogPrefix(postId)}article.mdx`;
// Images are content-addressed, so a key never changes bytes and the edge can
// hold it as immutable.
export const blogImageKey = (postId: string, sha256: string) => `${blogPrefix(postId)}${sha256}.avif`;
// A browser upload lands here first; the images route reads it, encodes it,
// and deletes it. The media Worker never serves this prefix.
export const blogUploadKey = (postId: string, uploadId: string) => `${blogPrefix(postId)}uploads/${uploadId}`;

// The one shape the media Worker serves without a token (worker/cf/media.ts
// checks the same pattern).
export const BLOG_PUBLIC_IMAGE_KEY = /^blog\/[a-z0-9]+\/[a-f0-9]{64}\.avif$/;
export const isBlogImageKey = (postId: string, key: string) =>
  BLOG_PUBLIC_IMAGE_KEY.test(key) && key.startsWith(blogPrefix(postId));

export const blogImageUrl = (key: string) => `${CUT_MEDIA_ORIGIN}/${key}`;

// A multiple of 6 so the 2-column and 3-column grids both end on full rows.
export const BLOG_PAGE_SIZE = 24;
export const blogPageCount = (total: number) => Math.max(1, Math.ceil(total / BLOG_PAGE_SIZE));

export const blogPath = (slug: string) => `/blog/${slug}`;
// Page 1 is the canonical /blog; later pages live under /blog/page/N.
export const blogPageHref = (page: number) => (page <= 1 ? "/blog" : `/blog/page/${page}`);
