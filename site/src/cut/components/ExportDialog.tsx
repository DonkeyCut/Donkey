"use client";

import { useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  EXPORT_PRESETS,
  estimateExportBytes,
  formatSizeEstimate,
  originalSettings,
  presetSettings,
} from "@/cut/lib/exportClient";
import { useExports } from "@/cut/lib/exportStore";
import { projectDuration, useEditor } from "@/cut/lib/store";
import { cn } from "@/lib/utils";

// Just a launcher: pick a preset, hand the cut to the engine, and close. Every
// export — progress, queue position, the finished file — is tracked in the
// app-wide exports dock, so starting one never blocks starting another.
export function ExportDialog() {
  const setExportOpen = useEditor((s) => s.setExportOpen);
  const aspect = useEditor((s) => s.aspect);
  const clips = useEditor((s) => s.clips);
  const assets = useEditor((s) => s.assets);
  const audioClips = useEditor((s) => s.audioClips);
  const overlays = useEditor((s) => s.overlays);
  const duration = useMemo(
    () => projectDuration({ clips, audioClips, overlays }),
    [clips, audioClips, overlays]
  );
  // "Original" leads: sized from the footage on the timeline, so it is always
  // the highest option. The fixed presets follow, flipped to the aspect.
  const presets = useMemo(
    () => [
      {
        id: "original",
        label: "Original · matches source",
        detail: "H.264 · best quality",
        settings: originalSettings(aspect, clips, assets),
      },
      ...EXPORT_PRESETS.map((p) => ({
        id: p.id,
        label: p.label,
        detail: p.detail,
        settings: presetSettings(p, aspect),
      })),
    ],
    [aspect, clips, assets]
  );
  const [presetId, setPresetId] = useState("original");

  const run = () => {
    const s = useEditor.getState();
    if (!s.projectId) return;
    const settings = (presets.find((p) => p.id === presetId) ?? presets[0]).settings;
    void useExports.getState().start(
      s.projectId,
      {
        aspect: s.aspect,
        assets: s.assets,
        clips: s.clips,
        audioClips: s.audioClips,
        overlays: s.overlays,
        subtitles: s.subtitles,
        fadeIn: s.fadeIn,
        fadeOut: s.fadeOut,
      },
      settings,
      s.projectName
    );
    setExportOpen(false); // the dock takes it from here
  };

  return (
    <Dialog open onOpenChange={(o) => !o && setExportOpen(false)}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>Export</DialogTitle>
        </DialogHeader>

        <div className="flex flex-col gap-2" role="radiogroup" aria-label="Export preset">
          {presets.map((p) => (
            <button
              key={p.id}
              role="radio"
              aria-checked={presetId === p.id}
              className={cn(
                "flex items-center gap-3 rounded-lg border border-border bg-background px-3 py-2.5 text-left transition-colors hover:border-input",
                presetId === p.id && "border-primary bg-primary/10"
              )}
              onClick={() => setPresetId(p.id)}
            >
              <span className="flex min-w-0 flex-col items-start">
                <span className="text-sm font-medium">{p.label}</span>
                <span className="text-xs text-muted-foreground">
                  {p.settings.width} × {p.settings.height} · {p.detail}
                </span>
              </span>
              <span className="ml-auto shrink-0 text-xs tabular-nums text-muted-foreground">
                {formatSizeEstimate(estimateExportBytes(p.settings, duration))}
              </span>
            </button>
          ))}
        </div>

        <DialogFooter className="flex-col gap-2 sm:flex-col">
          <Button className="w-full" onClick={run}>
            Export video
          </Button>
          <p className="text-center text-[11px] text-muted-foreground">
            Renders in the background. You can keep editing, open another project,
            or export more — each shows in the corner.
          </p>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
