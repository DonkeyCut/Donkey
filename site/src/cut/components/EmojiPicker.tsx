"use client";

import { type ReactElement, useMemo, useRef, useState } from "react";
import { Search } from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Input } from "@/components/ui/input";
import { useTranslations } from "next-intl";
import type { Messages } from "@/i18n/namespaces";
import { EMOJI_CATEGORIES, type EmojiEntry } from "@/cut/lib/emoji";

// One glyph per category for the jump bar along the bottom.
const CATEGORY_GLYPH: Record<string, string> = {
  "Smileys & People": "😀",
  "Animals & Nature": "🐻",
  "Food & Drink": "🍔",
  Activity: "⚽️",
  "Travel & Places": "✈️",
  Objects: "💡",
  Symbols: "❤️",
  Flags: "🏳️",
};

// The catalog key that names a category in the page's language; the category
// names are the Unicode groups, e.g. "Food & Drink".
type CategoryKey = keyof Messages["media"]["emoji"]["category"];

/**
 * iPhone-style emoji picker: a search field over the full Unicode set, category
 * sections you can jump between, and a scrolling grid. Picking inserts without
 * closing so several emoji can be added in a row.
 */
export function EmojiPicker({
  trigger,
  onPick,
}: {
  trigger: ReactElement;
  onPick: (emoji: string) => void;
}) {
  const t = useTranslations("media.emoji");
  const [query, setQuery] = useState("");
  const sections = useRef<Record<string, HTMLDivElement | null>>({});

  const q = query.trim().toLowerCase();
  const results = useMemo(() => {
    if (!q) return null;
    const terms = q.split(/\s+/);
    const hits: EmojiEntry[] = [];
    for (const cat of EMOJI_CATEGORIES) {
      for (const e of cat.emoji) {
        if (terms.every((t) => e[2].includes(t))) hits.push(e);
      }
    }
    return hits;
  }, [q]);

  return (
    <Popover>
      <PopoverTrigger render={trigger} />
      <PopoverContent
        align="end"
        className="flex h-80 w-[336px] flex-col overflow-hidden p-0"
      >
        <div className="border-b p-2">
          <div className="relative">
            <Search className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input
              autoFocus
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={t("search")}
              className="h-8 pl-8"
            />
          </div>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-2 py-1">
          {results ? (
            results.length ? (
              <Grid emoji={results} onPick={onPick} />
            ) : (
              <p className="py-10 text-center text-sm text-muted-foreground">
                {t("noResults")}
              </p>
            )
          ) : (
            EMOJI_CATEGORIES.map((cat) => (
              <div
                key={cat.name}
                ref={(el) => {
                  sections.current[cat.name] = el;
                }}
                style={{ contentVisibility: "auto", containIntrinsicSize: "auto 260px" }}
              >
                <div className="sticky top-0 z-10 bg-popover/95 py-1 text-xs font-medium text-muted-foreground backdrop-blur-sm">
                  {t(`category.${cat.name as CategoryKey}`)}
                </div>
                <Grid emoji={cat.emoji} onPick={onPick} />
              </div>
            ))
          )}
        </div>

        {!results && (
          <div className="flex items-center justify-between border-t px-1.5 py-1">
            {EMOJI_CATEGORIES.map((cat) => (
              <button
                key={cat.name}
                type="button"
                title={t(`category.${cat.name as CategoryKey}`)}
                aria-label={t(`category.${cat.name as CategoryKey}`)}
                className="grid size-7 place-items-center rounded text-base hover:bg-accent"
                onClick={() =>
                  sections.current[cat.name]?.scrollIntoView({ block: "start" })
                }
              >
                {CATEGORY_GLYPH[cat.name] ?? "•"}
              </button>
            ))}
          </div>
        )}
      </PopoverContent>
    </Popover>
  );
}

function Grid({
  emoji,
  onPick,
}: {
  emoji: EmojiEntry[];
  onPick: (emoji: string) => void;
}) {
  return (
    <div className="grid grid-cols-8 gap-0.5">
      {emoji.map((e) => (
        <button
          key={e[0]}
          type="button"
          title={e[1]}
          className="grid size-8 place-items-center rounded text-xl leading-none hover:bg-accent"
          onClick={() => onPick(e[0])}
        >
          {e[0]}
        </button>
      ))}
    </div>
  );
}
