import type { MetadataRoute } from "next";

import { DONKEYCUT_CANONICAL } from "@/cut/lib/hosts";

// Served at donkeycut.com/sitemap.xml via the proxy rewrite (src/proxy.ts);
// the apex keeps its own sitemap at src/app/sitemap.ts. The legal pages are
// canonical on this host, since they describe Donkey Cut.
export default function sitemap(): MetadataRoute.Sitemap {
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
