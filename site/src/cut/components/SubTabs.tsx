"use client";

import { cn } from "@/lib/utils";

/** The segmented sub-tab toggle at the top of a side-panel tab — Voice/Music
 * on Audio, Moving/Filters/Audio on Effects, Stickers/Shapes on Elements. */
export function SubTabs<T extends string>({
  tabs,
  value,
  onChange,
  className,
}: {
  tabs: readonly { id: T; label: string }[];
  value: T;
  onChange: (v: T) => void;
  /** Size and placement where the toggle sits outside a side panel. */
  className?: string;
}) {
  return (
    <div className={cn("flex w-full rounded-lg bg-muted p-0.5 text-[11.5px]", className)}>
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
