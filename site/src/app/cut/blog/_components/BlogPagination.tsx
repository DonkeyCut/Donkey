import { ChevronLeftIcon, ChevronRightIcon } from "lucide-react";
import Link from "next/link";

import { blogPageHref } from "@/lib/blog/keys";
import { cn } from "@/lib/utils";

// The page numbers to show, long runs folded into ellipses.
export function pageTokens(current: number, total: number): (number | "ellipsis")[] {
  if (total <= 7) return Array.from({ length: total }, (_, i) => i + 1);
  const tokens: (number | "ellipsis")[] = [1];
  const left = Math.max(2, current - 1);
  const right = Math.min(total - 1, current + 1);
  if (left > 2) tokens.push("ellipsis");
  for (let page = left; page <= right; page++) tokens.push(page);
  if (right < total - 1) tokens.push("ellipsis");
  tokens.push(total);
  return tokens;
}

const link =
  "inline-flex h-10 min-w-10 items-center justify-center gap-1 rounded-full border-2 px-3 text-sm font-semibold no-underline transition-colors";

function PageLink({ page, active, children }: { page: number; active?: boolean; children: React.ReactNode }) {
  return (
    <Link
      href={blogPageHref(page)}
      aria-current={active ? "page" : undefined}
      className={cn(link, active ? "border-ink bg-ink text-white" : "border-transparent text-ink hover:border-ink")}
    >
      {children}
    </Link>
  );
}

export function BlogPagination({ current, total }: { current: number; total: number }) {
  if (total <= 1) return null;
  return (
    <nav aria-label="Pagination" className="mt-16 flex flex-wrap items-center justify-center gap-1">
      {current > 1 ? (
        <PageLink page={current - 1}>
          <ChevronLeftIcon className="size-4" />
          <span className="hidden sm:inline">Previous</span>
        </PageLink>
      ) : null}
      {pageTokens(current, total).map((token, i) =>
        token === "ellipsis" ? (
          <span key={`e${i}`} className="px-2 text-[#666]">
            …
          </span>
        ) : (
          <PageLink key={token} page={token} active={token === current}>
            {token}
          </PageLink>
        ),
      )}
      {current < total ? (
        <PageLink page={current + 1}>
          <span className="hidden sm:inline">Next</span>
          <ChevronRightIcon className="size-4" />
        </PageLink>
      ) : null}
    </nav>
  );
}
