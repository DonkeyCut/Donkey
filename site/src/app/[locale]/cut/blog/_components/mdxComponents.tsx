import type { MDXComponents } from "mdx/types";
import Link from "next/link";
import type { ComponentPropsWithoutRef } from "react";

import { BlogCTA, InlineCTA } from "@/app/[locale]/cut/blog/_components/BlogCta";
import { BlogVideo } from "@/app/[locale]/cut/blog/_components/BlogVideo";
import { HeadingWithAnchor } from "@/app/[locale]/cut/blog/_components/HeadingWithAnchor";

// The typography plugin carries the article; only what prose cannot express
// is a component here: anchored headings, same-tab internal links, and the
// blocks an article can place by name.
export const BLOG_ARTICLE_CLASS =
  "prose prose-neutral dark:prose-invert max-w-none prose-headings:font-semibold prose-headings:text-foreground prose-headings:tracking-normal prose-h2:mt-10 prose-h2:text-2xl prose-h3:mt-8 prose-h3:text-xl prose-p:leading-[1.7] prose-a:font-semibold prose-a:text-foreground prose-strong:text-foreground prose-blockquote:border-l-coral prose-blockquote:text-foreground/70 prose-code:rounded prose-code:bg-foreground/5 prose-code:px-1.5 prose-code:py-0.5 prose-code:font-normal prose-code:before:content-none prose-code:after:content-none prose-pre:rounded-2xl prose-pre:border-2 prose-pre:border-foreground prose-pre:bg-ink prose-img:rounded-2xl prose-img:border-2 prose-img:border-foreground prose-hr:border-foreground/15 prose-th:text-foreground";

function Anchor({ href, children, ...props }: ComponentPropsWithoutRef<"a">) {
  if (href && href.startsWith("/") && !href.startsWith("//")) {
    return (
      <Link href={href} {...props}>
        {children}
      </Link>
    );
  }
  const external = Boolean(href && /^https?:\/\//.test(href));
  return (
    <a href={href} {...(external ? { target: "_blank", rel: "noopener noreferrer" } : {})} {...props}>
      {children}
    </a>
  );
}

export const blogMdxComponents: MDXComponents = {
  h2: ({ children }) => <HeadingWithAnchor as="h2">{children}</HeadingWithAnchor>,
  h3: ({ children }) => <HeadingWithAnchor as="h3">{children}</HeadingWithAnchor>,
  a: Anchor,
  // eslint-disable-next-line @next/next/no-img-element -- pre-encoded AVIF from the media host, not Next-optimizable
  img: ({ alt, ...props }) => <img alt={alt ?? ""} loading="lazy" {...props} />,
  table: ({ children }) => (
    <div className="overflow-x-auto">
      <table>{children}</table>
    </div>
  ),
  Video: BlogVideo,
  BlogCTA,
  InlineCTA,
};
