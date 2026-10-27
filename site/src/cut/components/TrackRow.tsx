"use client";

import { useState } from "react";
import { Loader2 } from "lucide-react";
import { useTranslations } from "next-intl";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { trackMotion } from "@/cut/lib/trackMotion";
import { TRACK_TARGETS, type TrackTarget } from "@/cut/lib/trackTargets";
import { useDescribeError } from "@/i18n/describeError";

/**
 * The inspector's motion-tracking control: pick what to track and the item's
 * mask traces it (`use: "mask"`), or the item rides it (`use: "follow"`).
 * Runs the same path as the chat's track_motion tool; while it reads the
 * footage the row shows how far it has got.
 */
export function TrackRow({ id, use }: { id: string; use: "mask" | "follow" }) {
  const t = useTranslations("timeline.trackRow");
  const describeError = useDescribeError();
  const [progress, setProgress] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Tracking runs once per pick; the row holds no target of its own, since
  // the result lives in the item's keys.
  const run = async (target: TrackTarget) => {
    setError(null);
    setProgress(0);
    try {
      await trackMotion({ id, target, use, onProgress: (share) => setProgress(Math.round(share * 100)) });
    } catch (e) {
      setError(describeError(e, t("failed")));
    } finally {
      setProgress(null);
    }
  };

  return (
    <>
      <div className="flex items-center justify-between gap-2 py-1">
        <span className="text-[11.5px] font-medium text-muted-foreground">{use === "mask" ? t("track") : t("follow")}</span>
        {progress !== null ? (
          <span className="flex h-8 items-center gap-1.5 text-[12px] text-muted-foreground">
            <Loader2 className="size-3.5 animate-spin" />
            {t("tracking", { progress })}
          </span>
        ) : (
          <Select
            value={null}
            items={Object.fromEntries(TRACK_TARGETS.map((target) => [target.id, t(`targets.${target.id}`)]))}
            onValueChange={(v) => {
              if (v) void run(v as TrackTarget);
            }}
          >
            <SelectTrigger className="h-8 w-36 text-[12px]">
              <SelectValue placeholder={t("pickTarget")} />
            </SelectTrigger>
            <SelectContent>
              {TRACK_TARGETS.map((target) => (
                <SelectItem key={target.id} value={target.id} className="text-[12px]">
                  {t(`targets.${target.id}`)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
      </div>
      {error && <p className="px-1 pb-1 text-[11.5px] leading-snug text-destructive">{error}</p>}
    </>
  );
}
