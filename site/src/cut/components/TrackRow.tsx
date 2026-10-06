"use client";

import { useState } from "react";
import { Loader2 } from "lucide-react";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { trackMotion } from "@/cut/lib/trackMotion";
import { TRACK_TARGETS, type TrackTarget } from "@/cut/lib/trackTargets";

/**
 * The inspector's motion-tracking control: pick what to track and the item's
 * mask traces it (`use: "mask"`), or the item rides it (`use: "follow"`).
 * Runs the same path as the chat's track_motion tool; while it reads the
 * footage the row shows how far it has got.
 */
export function TrackRow({ id, use }: { id: string; use: "mask" | "follow" }) {
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
      setError(e instanceof Error ? e.message : "Could not track the footage.");
    } finally {
      setProgress(null);
    }
  };

  return (
    <>
      <div className="flex items-center justify-between gap-2 py-1">
        <span className="text-[11.5px] font-medium text-muted-foreground">{use === "mask" ? "Track" : "Follow"}</span>
        {progress !== null ? (
          <span className="flex h-8 items-center gap-1.5 text-[12px] text-muted-foreground">
            <Loader2 className="size-3.5 animate-spin" />
            Tracking {progress}%
          </span>
        ) : (
          <Select
            value={null}
            items={Object.fromEntries(TRACK_TARGETS.map((t) => [t.id, t.label]))}
            onValueChange={(v) => {
              if (v) void run(v as TrackTarget);
            }}
          >
            <SelectTrigger className="h-8 w-36 text-[12px]">
              <SelectValue placeholder="Pick a target" />
            </SelectTrigger>
            <SelectContent>
              {TRACK_TARGETS.map((t) => (
                <SelectItem key={t.id} value={t.id} className="text-[12px]">
                  {t.label}
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
