import { ArrowLeft } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Suspense } from "react";

import { BlogHeaderImage } from "@/app/cut/blog/_components/BlogHeaderImage";
import { BlogShell } from "@/app/cut/blog/_components/BlogShell";
import { formatBlogDate, titleCaseTag } from "@/app/cut/blog/_components/blogDate";
import { ScrollToHash, TableOfContents } from "@/app/cut/blog/_components/TableOfContents";
import { DONKEYCUT_CANONICAL } from "@/cut/lib/hosts";
import { BLOG_SKELETON_ATTR, blogPath } from "@/lib/blog/keys";
import { getPost, listPublishedSlugs, type BlogPostPage } from "@/lib/blog/read";
import { PostArticle } from "@/lib/blog/render";

type Params = { params: Promise<{ slug: string }> };

// Cache Components needs at least one param; a blog with no published post
// gets a placeholder the page answers with 404.
export async function generateStaticParams() {
  const slugs = await listPublishedSlugs();
  return slugs.length > 0 ? slugs.map((slug) => ({ slug })) : [{ slug: "__placeholder__" }];
}

export async function generateMetadata({ params }: Params): Promise<Metadata> {
  const { slug } = await params;
  const post = await getPost(slug);
  if (!post) return {};
  const title = `${post.seoTitle || post.title} | Donkey Cut`;
  const description = post.summary || post.excerpt;
  const canonical = post.canonicalUrl || `${DONKEYCUT_CANONICAL}${blogPath(slug)}`;
  const image = post.headerUrl ?? post.thumbnailUrl;
  return {
    title,
    description,
    keywords: Array.from(new Set([...post.keywords, ...post.tags])),
    alternates: { canonical },
    robots: post.noIndex || post.status !== "PUBLISHED" ? { index: false, follow: false } : undefined,
    openGraph: {
      title,
      description,
      url: `${DONKEYCUT_CANONICAL}${blogPath(slug)}`,
      siteName: "Donkey Cut",
      type: "article",
      publishedTime: post.publishedAt ?? undefined,
      modifiedTime: post.revisedAt ?? post.publishedAt ?? undefined,
      tags: post.tags,
      images: image ? [{ url: image, alt: post.headerAlt ?? post.title }] : undefined,
    },
    twitter: {
      card: image ? "summary_large_image" : "summary",
      title,
      description,
      images: image ? [image] : undefined,
    },
  };
}

export const instant = true;

function jsonLd(post: BlogPostPage, url: string) {
  const article = {
    "@context": "https://schema.org",
    "@type": "BlogPosting",
    headline: post.title,
    description: post.summary || post.excerpt,
    url,
    mainEntityOfPage: { "@type": "WebPage", "@id": url },
    inLanguage: "en",
    datePublished: post.publishedAt ?? undefined,
    dateModified: post.revisedAt ?? post.publishedAt ?? undefined,
    publisher: {
      "@type": "Organization",
      name: "Donkey",
      url: DONKEYCUT_CANONICAL,
      logo: { "@type": "ImageObject", url: `${DONKEYCUT_CANONICAL}/donkey-logo.svg` },
    },
    ...(post.headerUrl ? { image: [post.headerUrl] } : {}),
    ...(post.keywords.length > 0 ? { keywords: post.keywords } : {}),
    ...(post.tags.length > 0 ? { articleSection: post.tags } : {}),
  };
  const faq =
    post.faq.length > 0
      ? {
          "@context": "https://schema.org",
          "@type": "FAQPage",
          mainEntity: post.faq.map((item) => ({
            "@type": "Question",
            name: item.question,
            acceptedAnswer: { "@type": "Answer", text: item.answer },
          })),
        }
      : null;
  return { article, faq };
}

function BackLink({ large }: { large?: boolean }) {
  return (
    <Link
      href="/blog"
      className={
        large
          ? "inline-flex items-center gap-2 text-base font-semibold text-ink no-underline transition-colors hover:text-coral"
          : "mb-6 inline-flex items-center gap-2 text-sm text-[#666] no-underline transition-colors hover:text-ink md:mb-8"
      }
    >
      <ArrowLeft className="size-4" />
      {large ? "Back to all posts" : "Back to blog"}
    </Link>
  );
}

// Everything under the params read. The post itself is a cached read, so this
// resolves from the cache for a published slug; Draft Mode re-runs it.
async function Post({ params }: Params) {
  const { slug } = await params;
  const post = await getPost(slug);
  if (!post) notFound();
  const url = `${DONKEYCUT_CANONICAL}${blogPath(slug)}`;
  const { article, faq } = jsonLd(post, url);
  const revised =
    post.revisedAt && post.publishedAt && new Date(post.revisedAt) > new Date(post.publishedAt)
      ? formatBlogDate(post.revisedAt)
      : null;
  return (
    <>
      <ScrollToHash />
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(article) }} />
      {faq ? <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(faq) }} /> : null}
      {post.status !== "PUBLISHED" ? (
        <div className="mb-6 flex flex-wrap items-center justify-between gap-3 rounded-2xl border-2 border-ink bg-coral px-4 py-3 text-sm font-semibold text-ink">
          <span>Draft preview. Only you can see this page.</span>
          <a href="/api/blog/preview/exit" className="underline underline-offset-2">
            Exit preview
          </a>
        </div>
      ) : null}
      <BackLink />
      {post.headerUrl ? <BlogHeaderImage src={post.headerUrl} alt={post.headerAlt ?? post.title} focus={post.headerFocus} /> : null}
      <div className="flex flex-col gap-12 lg:grid lg:grid-cols-[minmax(0,1fr)_16rem] lg:items-start">
        <div className="w-full max-w-[72ch]">
          <header className="mb-8 md:mb-12">
            {post.tags.length > 0 ? (
              <div className="mb-4 flex flex-wrap items-center gap-2">
                {post.tags.map((tag) => (
                  <span
                    key={tag}
                    className="inline-block rounded-md bg-ink px-2.5 py-1 text-[11px] font-semibold tracking-[0.08em] text-white uppercase"
                  >
                    {titleCaseTag(tag)}
                  </span>
                ))}
              </div>
            ) : null}
            <h1 className="mb-4 text-3xl font-semibold leading-tight text-balance text-ink md:text-5xl">{post.title}</h1>
            <div className="flex flex-wrap items-center gap-2 text-sm text-[#666]">
              {post.publishedAt ? <time dateTime={post.publishedAt}>{formatBlogDate(post.publishedAt)}</time> : null}
              {revised ? (
                <>
                  <span>&bull;</span>
                  <span>Updated {revised}</span>
                </>
              ) : null}
            </div>
            {post.summary ? <p className="mt-5 max-w-[60ch] text-lg leading-8 text-[#454545]">{post.summary}</p> : null}
          </header>
          <PostArticle slug={slug} />
        </div>
        <aside className="sticky top-24 hidden w-64 justify-self-end lg:block">
          <TableOfContents headings={post.headings} />
        </aside>
      </div>
      <div className="mt-12 pt-6 md:mt-16 md:pt-8">
        <BackLink large />
      </div>
    </>
  );
}

function PostSkeleton() {
  return (
    <div aria-hidden className="animate-pulse" {...{ [BLOG_SKELETON_ATTR]: "" }}>
      <div className="mb-8 h-60 rounded-2xl border-2 border-ink/10 bg-cream" />
      <div className="max-w-[72ch] space-y-4">
        <div className="h-10 w-3/4 rounded-lg bg-ink/10" />
        <div className="h-4 w-1/3 rounded bg-ink/10" />
        <div className="h-4 w-full rounded bg-ink/10" />
        <div className="h-4 w-5/6 rounded bg-ink/10" />
      </div>
    </div>
  );
}

export default function BlogPostPage({ params }: Params) {
  return (
    <BlogShell>
      <Suspense fallback={<PostSkeleton />}>
        <Post params={params} />
      </Suspense>
    </BlogShell>
  );
}
