import type { MetadataRoute } from "next";

import { useCases } from "@/app/use-cases/useCases";

const SITE_URL = "https://donkeyuse.com";

export default function sitemap(): MetadataRoute.Sitemap {
  const lastModified = new Date("2026-06-01");

  return [
    {
      changeFrequency: "weekly",
      lastModified,
      priority: 1,
      url: `${SITE_URL}/`,
    },
    {
      changeFrequency: "monthly",
      lastModified,
      priority: 0.8,
      url: `${SITE_URL}/pricing`,
    },
    {
      changeFrequency: "monthly",
      lastModified,
      priority: 0.8,
      url: `${SITE_URL}/donkeyvision`,
    },
    {
      changeFrequency: "weekly",
      lastModified,
      priority: 0.8,
      url: `${SITE_URL}/use-cases`,
    },
    ...useCases.map((useCase) => ({
      changeFrequency: "monthly" as const,
      lastModified,
      priority: 0.7,
      url: `${SITE_URL}/use-cases/${useCase.slug}`,
    })),
  ];
}
