import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { Suspense } from "react";

import { BlogGridSkeleton } from "@/app/[locale]/cut/blog/_components/BlogGrid";
import { BlogHeading, BlogIndex } from "@/app/[locale]/cut/blog/_components/BlogIndex";
import { BlogShell } from "@/app/[locale]/cut/blog/_components/BlogShell";
import { DONKEYCUT_CANONICAL } from "@/cut/lib/hosts";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("landing.blog");
  const title = t("metaTitle");
  const description = t("metaDescription");
  return {
    title,
    description,
    alternates: { canonical: `${DONKEYCUT_CANONICAL}/blog` },
    openGraph: {
      title,
      description,
      url: `${DONKEYCUT_CANONICAL}/blog`,
      siteName: "Donkey Cut",
      type: "website",
      images: [{ url: "/cut/landing/og.png", width: 1200, height: 630 }],
    },
    twitter: {
      card: "summary_large_image",
      title,
      description,
      images: ["/cut/landing/og.png"],
    },
  };
}

export const instant = true;

// The blog index, served at /blog by the proxy's "/…" → "/cut/…" rewrite. The
// list is a cached read, so it joins the static shell and refreshes when a
// save calls the revalidate route.
export default function BlogIndexPage() {
  return (
    <BlogShell>
      <BlogHeading />
      <Suspense fallback={<BlogGridSkeleton />}>
        <BlogIndex page={1} />
      </Suspense>
    </BlogShell>
  );
}
