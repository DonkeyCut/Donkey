import Link from "next/link";

import { formatBlogDate, titleCaseTag } from "@/app/cut/blog/_components/blogDate";
import type { BlogPostCard } from "@/lib/blog/read";
import { blogPath } from "@/lib/blog/keys";

function TagPills({ tags }: { tags: string[] }) {
  if (tags.length === 0) return null;
  return (
    <div className="flex flex-wrap items-center gap-2">
      {tags.map((tag) => (
        <span
          key={tag}
          className="inline-block rounded-md bg-ink px-2.5 py-1 text-[11px] font-semibold tracking-[0.08em] text-white uppercase"
        >
          {titleCaseTag(tag)}
        </span>
      ))}
    </div>
  );
}

function FeaturedCard({ post }: { post: BlogPostCard }) {
  return (
    <Link href={blogPath(post.slug)} className="group grid gap-6 no-underline lg:grid-cols-2 lg:gap-8">
      <div className="relative aspect-[2/1] overflow-hidden rounded-2xl border-2 border-ink bg-cream">
        {post.thumbnailUrl ? (
          // eslint-disable-next-line @next/next/no-img-element -- pre-encoded AVIF from the media host, not Next-optimizable
          <img
            src={post.thumbnailUrl}
            alt={post.title}
            width={800}
            height={500}
            fetchPriority="high"
            className="absolute inset-0 h-full w-full object-cover"
          />
        ) : null}
      </div>
      <div className="flex flex-col justify-center gap-4">
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-sm text-[#666]">
          {post.publishedAt ? <time dateTime={post.publishedAt}>{formatBlogDate(post.publishedAt)}</time> : null}
          <TagPills tags={post.tags} />
        </div>
        <h3 className="text-2xl font-semibold leading-tight text-balance text-ink transition-colors group-hover:text-coral md:text-3xl">
          {post.title}
        </h3>
        <p className="text-base leading-relaxed text-[#454545]">{post.excerpt}</p>
      </div>
    </Link>
  );
}

function PostCard({ post }: { post: BlogPostCard }) {
  return (
    <Link
      href={blogPath(post.slug)}
      className="group flex flex-col overflow-hidden rounded-2xl border-2 border-ink bg-cream no-underline transition-transform duration-300 hover:-translate-y-1"
    >
      <div className="relative aspect-[16/10] overflow-hidden border-b-2 border-ink bg-white">
        {post.thumbnailUrl ? (
          // eslint-disable-next-line @next/next/no-img-element -- pre-encoded AVIF from the media host, not Next-optimizable
          <img
            src={post.thumbnailUrl}
            alt={post.title}
            width={800}
            height={500}
            loading="lazy"
            className="absolute inset-0 h-full w-full object-cover brightness-90 contrast-125 grayscale transition-all duration-500 group-hover:brightness-100 group-hover:contrast-100 group-hover:grayscale-0"
          />
        ) : null}
      </div>
      <div className="flex flex-1 flex-col p-6">
        {post.publishedAt ? (
          <time dateTime={post.publishedAt} className="text-sm text-[#666]">
            {formatBlogDate(post.publishedAt)}
          </time>
        ) : null}
        <h3 className="my-2 text-xl font-semibold leading-[1.3] text-ink">{post.title}</h3>
        <p className="line-clamp-3 text-[15px] leading-[1.6] text-[#454545]">{post.excerpt}</p>
      </div>
    </Link>
  );
}

// The index: the featured post across the top of page one, then the latest
// posts in a grid.
export function BlogGrid({ posts, featured }: { posts: BlogPostCard[]; featured: BlogPostCard | null }) {
  return (
    <div className="space-y-16">
      {featured ? <FeaturedCard post={featured} /> : null}
      <section>
        <div className="mb-8 flex items-center gap-4">
          <h2 className="text-sm font-bold tracking-[0.05em] whitespace-nowrap text-ink uppercase">Latest posts</h2>
          <div className="h-0.5 w-full bg-ink/15" />
        </div>
        {posts.length === 0 ? (
          <p className="text-[#666]">Nothing here yet.</p>
        ) : (
          <div className="grid grid-cols-1 gap-6 md:grid-cols-2 md:gap-y-8 lg:grid-cols-3">
            {posts.map((post) => (
              <PostCard key={post.id} post={post} />
            ))}
          </div>
        )}
      </section>
    </div>
  );
}

export function BlogGridSkeleton() {
  return (
    <div className="grid grid-cols-1 gap-6 md:grid-cols-2 md:gap-y-8 lg:grid-cols-3" aria-hidden>
      {Array.from({ length: 6 }, (_, i) => (
        <div key={i} className="aspect-[4/5] animate-pulse rounded-2xl border-2 border-ink/10 bg-cream" />
      ))}
    </div>
  );
}
