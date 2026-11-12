"use client";

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { useTranslations } from "next-intl";
import { Loader2, Search, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { TEMPLATE_QUERY_MAX } from "@/cut/lib/templateGallery";

// How long typing rests before the search runs.
const SETTLE_MS = 400;

// One easing for the box and the chips, so they trade places as one motion.
const MOTION = "duration-300 ease-out motion-reduce:transition-none";

/**
 * The gallery's search, at the head of its filter row. Idle it is a small
 * pill; focused it widens across the row while the filter chips fade and fold
 * away behind it, and on blur the two trade back. Typing searches once it
 * rests; Enter searches at once, Escape clears and then leaves.
 */
export function TemplateSearch({
  query,
  busy,
  onSearch,
  children,
}: {
  /** The search the gallery shows now. */
  query: string;
  /** Whether that search is still being answered. */
  busy: boolean;
  onSearch: (query: string) => void;
  /** The filter chips the box replaces while it is open. */
  children: ReactNode;
}) {
  const t = useTranslations("home.templates");
  const input = useRef<HTMLInputElement>(null);
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState(query);

  // The last search this box sent. A search arriving from outside (Back,
  // Clear filters) shows in the box; the box's own search coming back
  // through the URL leaves what is being typed alone.
  const [sent, setSent] = useState(query);
  const [shown, setShown] = useState(query);
  if (query !== shown) {
    setShown(query);
    if (query !== sent) {
      setSent(query);
      setDraft(query);
    }
  }

  const send = useCallback(
    (next: string) => {
      setSent(next);
      onSearch(next);
    },
    [onSearch]
  );

  // Typing searches once it rests.
  useEffect(() => {
    const next = draft.trim();
    if (next === query) {
      return;
    }
    const timer = setTimeout(() => send(next), SETTLE_MS);
    return () => clearTimeout(timer);
  }, [draft, query, send]);

  const clear = () => {
    setDraft("");
    send("");
  };

  return (
    // The row scrolls sideways on a narrow screen without a bar, which would
    // otherwise flash while the chips fold away.
    <div className="-mx-4 flex items-center overflow-x-auto px-4 pt-1 pb-1 [scrollbar-width:none] sm:-mx-1 sm:px-1 [&::-webkit-scrollbar]:hidden">
      {/* The box: a pill when idle, wider when open. */}
      <label
        className={cn(
          "flex h-8 shrink-0 cursor-text items-center gap-1.5 rounded-full border border-foreground/20 bg-background px-3 text-[13px] transition-[width,background-color] hover:bg-muted dark:border-foreground/25",
          "focus-within:border-ring focus-within:ring-3 focus-within:ring-ring/50 focus-within:hover:bg-background",
          MOTION,
          open ? "w-[360px] max-w-full" : draft ? "w-48" : "w-40"
        )}
      >
        <Search className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
        <input
          ref={input}
          type="search"
          value={draft}
          maxLength={TEMPLATE_QUERY_MAX}
          placeholder={t("search")}
          aria-label={t("search")}
          onFocus={() => setOpen(true)}
          onBlur={() => setOpen(false)}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              send(draft.trim());
              return;
            }
            if (e.key !== "Escape") {
              return;
            }
            e.preventDefault();
            if (draft) {
              clear();
              return;
            }
            input.current?.blur();
          }}
          className="min-w-0 flex-1 truncate bg-transparent text-foreground outline-none placeholder:text-muted-foreground [&::-webkit-search-cancel-button]:hidden"
        />
        {busy && <Loader2 className="size-3.5 shrink-0 animate-spin text-muted-foreground" aria-hidden />}
        {draft && !busy && (
          <button
            type="button"
            aria-label={t("clearSearch")}
            // Keep focus in the box so clearing does not close it.
            onMouseDown={(e) => e.preventDefault()}
            onClick={clear}
            className="-mr-1 grid size-5 shrink-0 place-items-center rounded-full text-muted-foreground hover:bg-foreground/10 hover:text-foreground"
          >
            <X className="size-3" />
          </button>
        )}
      </label>

      {/* The chips fold away while the box is open, on one line so folding
          never stacks them. Their left padding is the gap after the box and
          keeps their focus rings inside the clip; it folds away with them. */}
      <div
        inert={open}
        aria-hidden={open}
        className={cn(
          "-my-1 flex shrink-0 gap-2 overflow-hidden py-1 transition-[max-width,opacity,translate,padding,margin]",
          MOTION,
          open ? "mr-0 max-w-0 -translate-x-2 px-0 opacity-0" : "-mr-1 max-w-[80rem] translate-x-0 pr-1 pl-2 opacity-100"
        )}
      >
        {children}
      </div>
    </div>
  );
}
