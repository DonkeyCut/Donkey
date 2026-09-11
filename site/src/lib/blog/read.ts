// The public read path. Every function here is a cache scope tagged so a save
// on su clears exactly the pages that showed the post. Draft Mode (the su
// Preview button) re-runs these per request without storing the result, and
// is the only way a draft reaches a page.
import { cacheLife, cacheTag } from "next/cache";
import { draftMode } from "next/headers";

import { extractFaqItems, type BlogFaqItem } from "@/lib/blog/faq";
import { extractHeadings, type BlogHeading } from "@/lib/blog/headings";
import { blogBodyKey, blogImageUrl } from "@/lib/blog/keys";
import { prisma } from "@/lib/prisma";
import { getObject } from "@/cut/server/cloud/r2";
import type { BlogPost } from "@/generated/prisma/client";

export const BLOG_TAG = "blog";
export const blogPostTag = (slug: string) => `blog:${slug}`;

export type BlogPostCard = {
  id: string;
  slug: string;
  status: "DRAFT" | "PUBLISHED";
  title: string;
  excerpt: string;
  summary: string | null;
  tags: string[];
  featured: boolean;
  publishedAt: string | null;
  revisedAt: string | null;
  headerUrl: string | null;
  headerAlt: string | null;
  headerFocus: string | null;
  thumbnailUrl: string | null;
  thumbnailFocus: string | null;
};

export type BlogPostPage = BlogPostCard & {
  keywords: string[];
  seoTitle: string | null;
  canonicalUrl: string | null;
  noIndex: boolean;
  body: string;
  faq: BlogFaqItem[];
  headings: BlogHeading[];
};

export function cardOf(row: BlogPost): BlogPostCard {
  return {
    id: row.id,
    slug: row.slug,
    status: row.status,
    title: row.title,
    excerpt: row.excerpt,
    summary: row.summary,
    tags: row.tags,
    featured: row.featured,
    publishedAt: row.publishedAt?.toISOString() ?? null,
    revisedAt: row.revisedAt?.toISOString() ?? null,
    headerUrl: row.headerKey ? blogImageUrl(row.headerKey) : null,
    headerAlt: row.headerAlt,
    headerFocus: row.headerFocus,
    thumbnailUrl: row.thumbnailKey ? blogImageUrl(row.thumbnailKey) : null,
    thumbnailFocus: row.thumbnailFocus,
  };
}

// The body as stored; a post whose object was never written reads as empty.
export async function readBody(postId: string): Promise<string> {
  const object = await getObject(blogBodyKey(postId));
  return object ? object.bytes.toString("utf8") : "";
}

// Published posts, newest first. Under Draft Mode the drafts join the list so
// a previewer sees where the post will land.
export async function listPublishedPosts(): Promise<BlogPostCard[]> {
  "use cache";
  cacheTag(BLOG_TAG);
  cacheLife("max");
  const { isEnabled } = await draftMode();
  const rows = await prisma.blogPost.findMany({
    where: isEnabled ? undefined : { status: "PUBLISHED" },
    orderBy: [{ publishedAt: { sort: "desc", nulls: "first" } }, { createdAt: "desc" }],
  });
  return rows.map(cardOf);
}

// One post with its body. Null for an unknown or unpublished slug; that answer
// is held briefly, since the slug may be published next.
export async function getPost(slug: string): Promise<BlogPostPage | null> {
  "use cache";
  cacheTag(BLOG_TAG, blogPostTag(slug));
  const { isEnabled } = await draftMode();
  const row = await prisma.blogPost.findUnique({ where: { slug } });
  if (!row || (!isEnabled && row.status !== "PUBLISHED")) {
    cacheLife("minutes");
    return null;
  }
  cacheLife("max");
  const body = await readBody(row.id);
  return {
    ...cardOf(row),
    keywords: row.keywords,
    seoTitle: row.seoTitle,
    canonicalUrl: row.canonicalUrl,
    noIndex: row.noIndex,
    body,
    faq: extractFaqItems(body),
    headings: extractHeadings(body),
  };
}

// Build-time only: the slugs to prerender. Uncached and free of request APIs,
// so generateStaticParams can call it.
export async function listPublishedSlugs(): Promise<string[]> {
  const rows = await prisma.blogPost.findMany({
    select: { slug: true },
    where: { status: "PUBLISHED" },
  });
  return rows.map((row) => row.slug);
}
