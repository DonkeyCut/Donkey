// The post as the su editor sees it: every column, image URLs resolved, dates
// as ISO strings. The body rides along only when one post is read.
import type { BlogPost } from "@/generated/prisma/client";

import { blogImageUrl } from "@/lib/blog/keys";
import { prisma } from "@/lib/prisma";

export type BlogPostAdmin = {
  id: string;
  slug: string;
  status: "DRAFT" | "PUBLISHED";
  title: string;
  excerpt: string;
  summary: string;
  tags: string[];
  keywords: string[];
  featured: boolean;
  publishedAt: string | null;
  revisedAt: string | null;
  headerKey: string | null;
  headerUrl: string | null;
  headerAlt: string;
  headerFocus: string | null;
  thumbnailKey: string | null;
  thumbnailUrl: string | null;
  seoTitle: string;
  canonicalUrl: string;
  noIndex: boolean;
  bodyVersion: number;
  createdAt: string;
  updatedAt: string;
};

export type BlogPostAdminWithBody = BlogPostAdmin & { body: string };

export function adminPost(row: BlogPost): BlogPostAdmin {
  return {
    id: row.id,
    slug: row.slug,
    status: row.status,
    title: row.title,
    excerpt: row.excerpt,
    summary: row.summary ?? "",
    tags: row.tags,
    keywords: row.keywords,
    featured: row.featured,
    publishedAt: row.publishedAt?.toISOString() ?? null,
    revisedAt: row.revisedAt?.toISOString() ?? null,
    headerKey: row.headerKey,
    headerUrl: row.headerKey ? blogImageUrl(row.headerKey) : null,
    headerAlt: row.headerAlt ?? "",
    headerFocus: row.headerFocus,
    thumbnailKey: row.thumbnailKey,
    thumbnailUrl: row.thumbnailKey ? blogImageUrl(row.thumbnailKey) : null,
    seoTitle: row.seoTitle ?? "",
    canonicalUrl: row.canonicalUrl ?? "",
    noIndex: row.noIndex,
    bodyVersion: row.bodyVersion,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export async function listAdminPosts(): Promise<BlogPostAdmin[]> {
  const rows = await prisma.blogPost.findMany({ orderBy: { updatedAt: "desc" } });
  return rows.map(adminPost);
}
