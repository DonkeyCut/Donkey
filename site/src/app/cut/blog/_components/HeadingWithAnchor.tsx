"use client";

import { Link2 } from "lucide-react";
import type { ReactNode } from "react";

import { headingId } from "@/lib/blog/headings";
import { cn } from "@/lib/utils";

const textOf = (node: ReactNode): string => {
  if (node === null || node === undefined || typeof node === "boolean") return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(textOf).join("");
  if (typeof node === "object" && "props" in node) {
    return textOf((node.props as { children?: ReactNode }).children);
  }
  return "";
};

// A section heading that is its own anchor: it carries an id from its text,
// and hovering shows a button that copies the link to it.
export function HeadingWithAnchor({
  as: Tag,
  children,
  className,
}: {
  as: "h2" | "h3";
  children: ReactNode;
  className?: string;
}) {
  const id = headingId(textOf(children));
  const copy = () => {
    const url = `${window.location.origin}${window.location.pathname}#${id}`;
    void navigator.clipboard.writeText(url);
    window.history.pushState(null, "", `#${id}`);
  };
  return (
    <Tag id={id || undefined} className={cn("group relative scroll-mt-24", className)}>
      {children}
      {id ? (
        <button
          type="button"
          onClick={copy}
          className="ml-2 inline-flex align-middle opacity-0 transition-opacity group-hover:opacity-100"
          aria-label="Copy link to section"
          title="Copy link to section"
        >
          <Link2 className="size-4 text-[#666] hover:text-ink" />
        </button>
      ) : null}
    </Tag>
  );
}
