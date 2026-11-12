"use client";

import type { ReactNode } from "react";
import { useTranslations } from "next-intl";
import { cn } from "@/lib/utils";

// The Assets list's columns: name, length, size, edited, actions. Folders,
// notes, projects and files all fill the same five.
const ASSET_COLUMNS = "grid grid-cols-[1fr_90px_70px_110px_40px] items-center gap-3";

/** One row of the Assets list. */
export const ASSET_ROW = cn(
  ASSET_COLUMNS,
  "cursor-pointer border-b border-border px-4 py-2.5 text-sm transition-colors hover:bg-muted/50",
);

/** A picked row, in the selection blue. */
export const ASSET_ROW_PICKED = "bg-[#0a84ff]/10 hover:bg-[#0a84ff]/15";

/**
 * The Assets list: a framed table under a header row. Unframed, it holds its
 * rows' hosts without drawing anything, so the folder and note hosts stay
 * mounted (a folder being named, a note being opened) while nothing lists.
 */
export function AssetTable({ framed, children }: { framed: boolean; children: ReactNode }) {
  const t = useTranslations("home.projects");
  if (!framed) {
    return <div>{children}</div>;
  }
  return (
    <div className="overflow-hidden rounded-xl border border-border bg-card">
      <div
        className={cn(
          ASSET_COLUMNS,
          "border-b border-border bg-muted/50 px-4 py-2 text-xs font-medium tracking-wide text-muted-foreground uppercase",
        )}
      >
        <span className="truncate">{t("columnName")}</span>
        <span className="truncate">{t("columnLength")}</span>
        <span className="truncate">{t("columnSize")}</span>
        <span className="truncate">{t("columnEdited")}</span>
        <span />
      </div>
      {/* The last row's rule tucks under the frame's own border. */}
      <div className="-mb-px">{children}</div>
    </div>
  );
}
