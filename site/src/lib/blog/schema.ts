// The editor's contract for a post, shared by the su form and the routes.
// Saving a draft is lenient so a half-written post can be kept; publishing
// holds the post to the full contract (publishIssues).
import { z } from "zod";

export const BLOG_TITLE_MAX = 60;
export const BLOG_DESCRIPTION_MIN = 70;
export const BLOG_DESCRIPTION_MAX = 155;
export const BLOG_SEO_TITLE_MAX = 70;

// Words the router owns under /blog.
const RESERVED_SLUGS = new Set(["page"]);

// Lowercase words joined by single hyphens. No dots: the proxy matcher treats
// a path with a dot as a file and never rewrites it to the page.
export const blogSlugSchema = z
  .string()
  .trim()
  .min(1, "A slug is required.")
  .max(200, "Keep the slug under 200 characters.")
  .regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, "Use lowercase letters, digits and single hyphens.")
  .refine((slug) => !RESERVED_SLUGS.has(slug), "That word is reserved.");

const words = z
  .array(z.string().trim().min(1).max(80))
  .max(30)
  .transform((items) => Array.from(new Set(items)));

const isoDate = z
  .string()
  .refine((value) => !Number.isNaN(new Date(value).getTime()), "Not a date.")
  .nullable();

export const blogFocusSchema = z.string().regex(/^\d{1,3}(\.\d+)?% \d{1,3}(\.\d+)?%$/, "Use the form \"50% 50%\".");

export const blogPostInputSchema = z
  .object({
    slug: blogSlugSchema,
    title: z.string().trim().max(200),
    excerpt: z.string().trim().max(400),
    summary: z.string().trim().max(400),
    tags: words,
    keywords: words,
    featured: z.boolean(),
    publishedAt: isoDate,
    revisedAt: isoDate,
    headerAlt: z.string().trim().max(400),
    headerFocus: blogFocusSchema.nullable(),
    thumbnailFocus: blogFocusSchema.nullable(),
    seoTitle: z.string().trim().max(200),
    canonicalUrl: z.union([z.literal(""), z.string().trim().url()]),
    noIndex: z.boolean(),
    body: z.string().max(2_000_000),
  })
  .strict();

export type BlogPostInput = z.infer<typeof blogPostInputSchema>;

export type BlogPublishIssue = { path: string; message: string };

// What a finished post has. The editor lists what is still missing as
// suggestions; publishing does not wait for them.
export function publishIssues(post: {
  title: string;
  excerpt: string;
  summary: string | null;
  headerKey: string | null;
  thumbnailKey: string | null;
  publishedAt: string | null;
  body: string;
}): BlogPublishIssue[] {
  const issues: BlogPublishIssue[] = [];
  const title = post.title.trim();
  if (title.length === 0) issues.push({ path: "title", message: "Give the post a title." });
  else if (title.length > BLOG_TITLE_MAX) {
    issues.push({ path: "title", message: `Keep the title to ${BLOG_TITLE_MAX} characters.` });
  }
  const excerpt = post.excerpt.trim();
  if (excerpt.length < BLOG_DESCRIPTION_MIN || excerpt.length > BLOG_DESCRIPTION_MAX) {
    issues.push({
      path: "excerpt",
      message: `The meta description is ${BLOG_DESCRIPTION_MIN} to ${BLOG_DESCRIPTION_MAX} characters.`,
    });
  }
  const summary = post.summary?.trim() ?? "";
  if (summary.length > 0 && (summary.length < BLOG_DESCRIPTION_MIN || summary.length > BLOG_DESCRIPTION_MAX)) {
    issues.push({
      path: "summary",
      message: `A summary is ${BLOG_DESCRIPTION_MIN} to ${BLOG_DESCRIPTION_MAX} characters, or empty.`,
    });
  }
  if (!post.headerKey) issues.push({ path: "header", message: "Upload a header image." });
  if (!post.thumbnailKey) issues.push({ path: "thumbnail", message: "Upload a thumbnail." });
  if (post.publishedAt && new Date(post.publishedAt).getTime() > Date.now()) {
    issues.push({ path: "publishedAt", message: "The publish date cannot be in the future." });
  }
  if (post.body.trim().length === 0) issues.push({ path: "body", message: "Write the article." });
  return issues;
}

// The slug a title suggests: the words, lowercased and hyphenated.
export function slugFromTitle(title: string): string {
  return title
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 200)
    .replace(/-+$/, "");
}
