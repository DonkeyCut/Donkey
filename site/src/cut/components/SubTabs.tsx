"use client";

import { cn } from "@/lib/utils";

/** The segmented sub-tab toggle at the top of a side-panel tab — Voice/Music
 * on Audio, Moving/Filters/Audio on Effects, Stickers/Shapes on Elements. */
export function SubTabs<T extends string>({
  tabs,
  value,
  onChange,
}: {
  tabs: readonly { id: T; label: string }[];
  value: T;
  onChange: (v: T) => void;
}) {
  return (
    <div className="flex w-full rounded-lg bg-muted p-0.5 text-[11.5px]">
      {tabs.map((t) => (
        <button
          key={t.id}
          type="button"
          onClick={() => onChange(t.id)}
          className={cn(
            "flex-1 rounded-md px-3 py-0.5 font-medium transition-colors",
            value === t.id
              ? "bg-background text-foreground shadow-sm"
              : "text-muted-foreground hover:text-foreground"
          )}
        >
          {t.label}
        </button>
      ))}
    </div>
  );
}
