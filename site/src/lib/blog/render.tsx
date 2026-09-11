// The article body, compiled once per post and held in the cache under the
// post's tags. JSX is a permitted cache value, so the compile runs when the
// post is saved or the cache is cold, never per visit.
import { cacheLife, cacheTag } from "next/cache";
import { compileMDX } from "next-mdx-remote/rsc";
import remarkGfm from "remark-gfm";

import { BLOG_ARTICLE_CLASS, blogMdxComponents } from "@/app/cut/blog/_components/mdxComponents";
import { BLOG_TAG, blogPostTag, getPost } from "@/lib/blog/read";

export async function PostArticle({ slug }: { slug: string }) {
  "use cache";
  cacheTag(BLOG_TAG, blogPostTag(slug));
  cacheLife("max");
  const post = await getPost(slug);
  if (!post) return null;
  const { content } = await compileMDX({
    source: post.body,
    components: blogMdxComponents,
    options: { mdxOptions: { remarkPlugins: [remarkGfm] } },
  });
  return <article className={BLOG_ARTICLE_CLASS}>{content}</article>;
}
