// Every write on su ends here, so the list, the sitemap and the post's own
// page drop their copies at once. Expired outright: a route handler cannot use
// updateTag, and the stale-while-revalidate profile would show the first
// visitor after a publish the page from before it.
//
// Then the pages are rendered again before anyone asks for them. A fetch of
// the address is the visit that makes Next render the index and the post with
// everything cached and keep the result as a static page, including for a post
// published after the deploy. The fetch repeats until the answer carries no
// skeleton, so the first reader gets the finished page. Publishing waits for
// it; the other writes let it run after their response.
import { revalidateTag } from "next/cache";
import { after } from "next/server";

import { CUT_HOSTED_ORIGIN } from "@/cut/lib/hosts";
import { BLOG_SKELETON_ATTR, blogPath } from "@/lib/blog/keys";
import { BLOG_TAG, blogPostTag } from "@/lib/blog/read";

const WARM_TRIES = 12;
const WARM_DELAY_MS = 500;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// The marker as a rendered attribute. The page's React payload names it too,
// as a prop of the fallback, on the finished page as well as on the shell.
const SKELETON_MARKUP = ` ${BLOG_SKELETON_ATTR}=""`;

// Fetches the page until it comes back rendered. Resolves true when it did.
async function warmPath(path: string): Promise<boolean> {
  for (let attempt = 0; attempt < WARM_TRIES; attempt++) {
    try {
      const response = await fetch(`${CUT_HOSTED_ORIGIN}${path}`, { cache: "no-store" });
      const html = await response.text();
      if (response.ok && !html.includes(SKELETON_MARKUP)) return true;
      if (response.status === 404) return false;
    } catch {
      // The host was not reachable this time; the next try may be.
    }
    await sleep(WARM_DELAY_MS);
  }
  return false;
}

export async function warmBlog(slugs: string[]): Promise<void> {
  await Promise.all(["/blog", ...Array.from(new Set(slugs), blogPath)].map(warmPath));
}

export function revalidateBlog(slugs: string[]): void {
  revalidateTag(BLOG_TAG, { expire: 0 });
  for (const slug of new Set(slugs)) revalidateTag(blogPostTag(slug), { expire: 0 });
}

// Expires and renders again before the response goes out, so the address is
// static the moment the caller hears back.
export async function revalidateBlogNow(slugs: string[]): Promise<void> {
  revalidateBlog(slugs);
  await warmBlog(slugs);
}

// Expires now, renders again once the response has gone out.
export function revalidateBlogLater(slugs: string[]): void {
  revalidateBlog(slugs);
  after(() => warmBlog(slugs));
}
