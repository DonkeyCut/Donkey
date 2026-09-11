import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { Suspense } from "react";

import { BlogGridSkeleton } from "@/app/cut/blog/_components/BlogGrid";
import { BLOG_INDEX_DESCRIPTION, BLOG_INDEX_TITLE, BlogHeading, BlogIndex } from "@/app/cut/blog/_components/BlogIndex";
import { BlogShell } from "@/app/cut/blog/_components/BlogShell";
import { DONKEYCUT_CANONICAL } from "@/cut/lib/hosts";
import { blogPageCount, blogPageHref } from "@/lib/blog/keys";
import { listPublishedSlugs } from "@/lib/blog/read";

type Params = { params: Promise<{ n: string }> };

// Pages 2 onward; page 1 is /blog itself.
const parsePage = (value: string) => {
  const page = Number(value);
  return Number.isInteger(page) && page >= 2 ? page : null;
};

// Cache Components needs at least one param; a blog with one page gets a
// placeholder the page answers with 404.
export async function generateStaticParams() {
  const total = blogPageCount((await listPublishedSlugs()).length);
  const pages = Array.from({ length: Math.max(0, total - 1) }, (_, i) => ({ n: String(i + 2) }));
  return pages.length > 0 ? pages : [{ n: "0" }];
}

export async function generateMetadata({ params }: Params): Promise<Metadata> {
  const page = parsePage((await params).n);
  if (!page) return {};
  const title = `${BLOG_INDEX_TITLE} — Page ${page}`;
  return {
    title,
    description: BLOG_INDEX_DESCRIPTION,
    alternates: { canonical: `${DONKEYCUT_CANONICAL}${blogPageHref(page)}` },
    openGraph: { title, description: BLOG_INDEX_DESCRIPTION, siteName: "Donkey Cut", type: "website" },
  };
}

export const instant = true;

async function PageIndex({ params }: Params) {
  const page = parsePage((await params).n);
  if (!page) notFound();
  return <BlogIndex page={page} />;
}

export default function BlogPagePage({ params }: Params) {
  return (
    <BlogShell>
      <BlogHeading />
      <Suspense fallback={<BlogGridSkeleton />}>
        <PageIndex params={params} />
      </Suspense>
    </BlogShell>
  );
}
