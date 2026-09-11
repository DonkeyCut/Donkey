import { notFound } from "next/navigation";

import { BlogGrid } from "@/app/cut/blog/_components/BlogGrid";
import { BlogPagination } from "@/app/cut/blog/_components/BlogPagination";
import { BLOG_PAGE_SIZE, blogPageCount } from "@/lib/blog/keys";
import { listPublishedPosts } from "@/lib/blog/read";

export const BLOG_INDEX_TITLE = "Blog | Donkey Cut";
export const BLOG_INDEX_DESCRIPTION =
  "Notes from building Donkey Cut: video editing techniques, how the editor works, and what changed.";

export function BlogHeading() {
  return (
    <div className="mb-8 max-w-[72ch] md:mb-12">
      <h1 className="text-4xl font-semibold tracking-tight text-ink lg:text-5xl">Blog</h1>
      <p className="mt-4 text-lg text-[#454545]">Notes on editing video, and on building the editor.</p>
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
      {featured ? <hr className="mb-8 border-ink/15 md:mb-12" /> : null}
      <BlogGrid posts={slice} featured={featured} />
      <BlogPagination current={page} total={total} />
    </>
  );
}
