import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";

import { BlogGrid } from "@/app/[locale]/cut/blog/_components/BlogGrid";
import { BlogPagination } from "@/app/[locale]/cut/blog/_components/BlogPagination";
import { BLOG_PAGE_SIZE, blogPageCount } from "@/lib/blog/keys";
import { listPublishedPosts } from "@/lib/blog/read";

export async function BlogHeading() {
  const t = await getTranslations("landing.blog");
  return (
    <div className="mb-8 max-w-[72ch] md:mb-12">
      <h1 className="text-4xl font-semibold tracking-tight text-foreground lg:text-5xl">{t("heading")}</h1>
      <p className="mt-4 text-lg text-foreground/70">{t("subtitle")}</p>
    </div>
  );
}

// One page of the index. The featured post rides page one whatever its date.
export async function BlogIndex({ page }: { page: number }) {
  const posts = await listPublishedPosts();
  const total = blogPageCount(posts.length);
  if (page < 1 || page > total) notFound();
  const featured = page === 1 ? (posts.find((post) => post.featured) ?? null) : null;
  const slice = posts.slice((page - 1) * BLOG_PAGE_SIZE, page * BLOG_PAGE_SIZE);
  return (
    <>
      {featured ? <hr className="mb-8 border-foreground/15 md:mb-12" /> : null}
      <BlogGrid posts={slice} featured={featured} />
      <BlogPagination current={page} total={total} />
    </>
  );
}
