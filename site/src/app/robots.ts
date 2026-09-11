import type { MetadataRoute } from "next";

import { DONKEYCUT_CANONICAL } from "@/cut/lib/hosts";

// Served at donkeycut.com/robots.txt. The proxy matcher skips paths with an
// extension, so this route answers directly on every host. Build assets under
// /_next/ stay crawlable because Google fetches them to render the pages;
// the noindex header in next.config.ts keeps them out of the index.
export default function robots(): MetadataRoute.Robots {
  return {
    rules: {
      userAgent: "*",
      allow: "/",
      disallow: ["/api/", "/app/", "/su/", "/sign-in", "/sign-up", "/unsubscribe"],
    },
    sitemap: `${DONKEYCUT_CANONICAL}/sitemap.xml`,
  };
}
