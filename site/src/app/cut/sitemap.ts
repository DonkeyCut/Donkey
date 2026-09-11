import type { MetadataRoute } from "next";

import { DONKEYCUT_CANONICAL } from "@/cut/lib/hosts";
import { blogPageCount, blogPageHref, blogPath } from "@/lib/blog/keys";
import { listPublishedPosts } from "@/lib/blog/read";

// Served at donkeycut.com/sitemap.xml via the proxy rewrite (src/proxy.ts).
// The legal pages are canonical on this host, since they describe Donkey Cut.
// The blog entries come from the same cached read the index uses, so a
// publish on su refreshes them; the dates are the rows' own, never the clock,
// which keeps the route prerenderable.
export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const posts = await listPublishedPosts();
  const pages = blogPageCount(posts.length);
  return [
    {
      url: `${DONKEYCUT_CANONICAL}/`,
      changeFrequency: "weekly",
      priority: 1,
    },
    {
      url: `${DONKEYCUT_CANONICAL}/install`,
      changeFrequency: "monthly",
      priority: 0.8,
    },
    {
      url: `${DONKEYCUT_CANONICAL}/blog`,
      changeFrequency: "weekly",
      priority: 0.8,
    },
    ...Array.from({ length: Math.max(0, pages - 1) }, (_, i) => ({
      url: `${DONKEYCUT_CANONICAL}${blogPageHref(i + 2)}`,
      changeFrequency: "weekly" as const,
      priority: 0.4,
    })),
    ...posts.map((post) => ({
      url: `${DONKEYCUT_CANONICAL}${blogPath(post.slug)}`,
      lastModified: post.revisedAt ?? post.publishedAt ?? undefined,
      changeFrequency: "monthly" as const,
      priority: 0.7,
    })),
    {
      url: `${DONKEYCUT_CANONICAL}/privacy`,
      changeFrequency: "yearly",
      priority: 0.5,
    },
    {
      url: `${DONKEYCUT_CANONICAL}/terms`,
      changeFrequency: "yearly",
      priority: 0.5,
    },
  ];
}
