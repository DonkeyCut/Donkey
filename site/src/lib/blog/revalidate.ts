// Every write on su ends here, so the list, the sitemap and the post's own
// page drop their copies at once. Expired outright: a route handler cannot use
// updateTag, and the stale-while-revalidate profile would show the first
// visitor after a publish the page from before it.
import { revalidateTag } from "next/cache";

import { BLOG_TAG, blogPostTag } from "@/lib/blog/read";

export function revalidateBlog(slugs: string[]): void {
  revalidateTag(BLOG_TAG, { expire: 0 });
  for (const slug of new Set(slugs)) revalidateTag(blogPostTag(slug), { expire: 0 });
}
