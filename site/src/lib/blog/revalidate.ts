// Every write on su ends here, so the list, the sitemap and the post's own
// page drop their copies at once. Expired outright: a route handler cannot use
// updateTag, and the stale-while-revalidate profile would show the first
// visitor after a publish the page from before it.
//
// Then the pages are fetched once after the response goes out. That visit is
// what makes Next render the index and the post again with everything cached,
// so the next reader gets a finished static page, never the shell with its
// skeleton, including for a post published after the deploy.
import { revalidateTag } from "next/cache";
import { after } from "next/server";

import { CUT_HOSTED_ORIGIN } from "@/cut/lib/hosts";
import { blogPath } from "@/lib/blog/keys";
import { BLOG_TAG, blogPostTag } from "@/lib/blog/read";

export function revalidateBlog(slugs: string[]): void {
  const unique = new Set(slugs);
  revalidateTag(BLOG_TAG, { expire: 0 });
  for (const slug of unique) revalidateTag(blogPostTag(slug), { expire: 0 });
  after(async () => {
    const paths = ["/blog", ...Array.from(unique, blogPath)];
    await Promise.all(
      paths.map((path) =>
        fetch(`${CUT_HOSTED_ORIGIN}${path}`, { cache: "no-store", headers: { "x-blog-warm": "1" } }).then(
          (response) => response.body?.cancel(),
          () => undefined,
        ),
      ),
    );
  });
}
