import type { Metadata } from "next";
import { Suspense } from "react";

import { BlogGridSkeleton } from "@/app/cut/blog/_components/BlogGrid";
import { BLOG_INDEX_DESCRIPTION, BLOG_INDEX_TITLE, BlogHeading, BlogIndex } from "@/app/cut/blog/_components/BlogIndex";
import { BlogShell } from "@/app/cut/blog/_components/BlogShell";
import { DONKEYCUT_CANONICAL } from "@/cut/lib/hosts";

export const metadata: Metadata = {
  title: BLOG_INDEX_TITLE,
  description: BLOG_INDEX_DESCRIPTION,
  alternates: { canonical: `${DONKEYCUT_CANONICAL}/blog` },
  openGraph: {
    title: BLOG_INDEX_TITLE,
    description: BLOG_INDEX_DESCRIPTION,
    url: `${DONKEYCUT_CANONICAL}/blog`,
    siteName: "Donkey Cut",
    type: "website",
    images: [{ url: "/cut/landing/og.png", width: 1200, height: 630 }],
  },
  twitter: {
    card: "summary_large_image",
    title: BLOG_INDEX_TITLE,
    description: BLOG_INDEX_DESCRIPTION,
    images: ["/cut/landing/og.png"],
  },
};

export const instant = true;

// The blog index, served at /blog by the proxy's "/…" → "/cut/…" rewrite. The
// list is a cached read, so it joins the static shell and refreshes when a
// post is saved on su.
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
