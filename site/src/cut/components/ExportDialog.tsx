"use client";

import { useEffect, useMemo, useState } from "react";
import { ChevronDown } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import {
  EXPORT_AUDIO,
  EXPORT_CODECS,
  EXPORT_CONTAINERS,
  EXPORT_FRAME_RATES,
  EXPORT_QUALITIES,
  EXPORT_QUICK_PRESETS,
  choiceSettings,
  estimateExportBytes,
  formatSizeEstimate,
  quickPresetOf,
  resolutionOptions,
  resolveResolution,
  type ExportChoice,
} from "@/cut/lib/exportClient";
import { useCutMode } from "@/cut/lib/backend/hooks";
import { canRenderInBrowser } from "@/cut/lib/exportRender";
import { useExports } from "@/cut/lib/exportStore";
import { projectDuration, useEditor } from "@/cut/lib/store";
import { cn } from "@/lib/utils";

// Just a launcher: pick a preset or set every axis yourself, hand the cut to
// the engine, and close. Every export — progress, queue position, the
// finished file — is tracked in the app-wide exports dock, so starting one
// never blocks starting another.
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
  const resolutions = useMemo(
    () => resolutionOptions(aspect, clips, assets),
    [aspect, clips, assets]
  );
  const [choice, setChoice] = useState<ExportChoice>(EXPORT_QUICK_PRESETS[1].choice);
  const [advanced, setAdvanced] = useState(false);
  // The field's own text, so a decimal in progress ("1.") survives the parse.
  const [mbpsText, setMbpsText] = useState("");
  const preset = quickPresetOf(choice, resolutions);
  const settings = useMemo(() => choiceSettings(choice, resolutions), [choice, resolutions]);
  const set = (patch: Partial<ExportChoice>) => setChoice((c) => ({ ...c, ...patch }));

  // A browser-resident project renders in this tab when it can, and on the
  // cloud worker when it can't; ask up front which it is, so the dialog says
  // where the render is going.
  const cutMode = useCutMode();
  const [browserFits, setBrowserFits] = useState(true);
  const inTab = cutMode !== "browser" || browserFits;
  useEffect(() => {
    if (cutMode !== "browser") return;
    let alive = true;
    const s = useEditor.getState();
    void canRenderInBrowser(
      {
        aspect: s.aspect,
        assets: s.assets,
        clips: s.clips,
        audioClips: s.audioClips,
        overlays: s.overlays,
        subtitles: s.subtitles,
        fadeIn: s.fadeIn,
        fadeOut: s.fadeOut,
        background: s.background,
      },
      settings
    ).then((ok) => {
      if (alive) setBrowserFits(ok);
    });
    return () => {
      alive = false;
    };
  }, [cutMode, settings]);

  const run = () => {
    const s = useEditor.getState();
    if (!s.projectId) return;
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
        background: s.background,
      },
      settings,
      s.projectName
    );
    setExportOpen(false); // the dock takes it from here
  };

  const codecLabel = EXPORT_CODECS.find((c) => c.id === settings.codec)?.label ?? settings.codec;
  const prores = settings.codec === "prores";

  return (
    <Dialog open onOpenChange={(o) => !o && setExportOpen(false)}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Export</DialogTitle>
        </DialogHeader>

        <div className="grid grid-cols-2 gap-1.5" role="radiogroup" aria-label="Export preset">
          {EXPORT_QUICK_PRESETS.map((p) => (
            <button
              key={p.id}
              type="button"
              role="radio"
              aria-checked={preset === p.id}
              className={cn(
                "flex flex-col items-start rounded-lg border border-border bg-background px-3 py-2 text-left transition-colors hover:border-input",
                preset === p.id && "border-primary bg-primary/10"
              )}
              onClick={() => {
                setMbpsText("");
                setChoice({ ...p.choice });
              }}
            >
              <span className="text-sm font-medium">{p.label}</span>
              <span className="text-[11px] text-muted-foreground">{p.detail}</span>
            </button>
          ))}
        </div>

        <button
          type="button"
          className="flex items-center gap-1 self-start text-xs font-medium text-muted-foreground hover:text-foreground"
          aria-expanded={advanced}
          onClick={() => setAdvanced((a) => !a)}
        >
          <ChevronDown className={cn("size-3.5 transition-transform", advanced && "rotate-180")} />
          Advanced
        </button>

        {advanced && (
          <div className="flex flex-col gap-3">
            <Choice label="Format">
              {EXPORT_CONTAINERS.map((c) => (
                <Pill
                  key={c.id}
                  checked={settings.container === c.id}
                  // MP4 can't carry ProRes or PCM; MOV is what they take.
                  disabled={c.id === "mp4" && (prores || settings.audioCodec === "pcm")}
                  onClick={() => set({ container: c.id })}
                  title={c.label}
                />
              ))}
            </Choice>
            <Choice label="Codec">
              {EXPORT_CODECS.map((c) => (
                <Pill
                  key={c.id}
                  checked={settings.codec === c.id}
                  onClick={() =>
                    set({
                      codec: c.id,
                      ...(c.id === "prores" ? { container: "mov", bitrateMbps: undefined } : {}),
                    })
                  }
                  title={c.label}
                  detail={c.detail}
                />
              ))}
            </Choice>
            <Choice label="Resolution">
              {resolutions.map((r) => (
                <Pill
                  key={r.id}
                  checked={resolveResolution(resolutions, choice.resolution).id === r.id}
                  onClick={() => set({ resolution: r.id })}
                  title={r.label}
                  detail={`${r.width} × ${r.height}`}
                />
              ))}
            </Choice>
            <Choice label="Frame rate">
              {EXPORT_FRAME_RATES.map((f) => (
                <Pill key={f} checked={choice.fps === f} onClick={() => set({ fps: f })} title={`${f} fps`} />
              ))}
            </Choice>
            {!prores && (
              <Choice label="Quality">
                {EXPORT_QUALITIES.map((q) => (
                  <Pill
                    key={q.id}
                    checked={!choice.bitrateMbps && choice.quality === q.id}
                    onClick={() => {
                      setMbpsText("");
                      set({ quality: q.id, bitrateMbps: undefined });
                    }}
                    title={q.label}
                    detail={q.detail}
                  />
                ))}
                <label
                  className={cn(
                    "flex min-w-[4.5rem] items-center gap-1.5 rounded-lg border border-border bg-background px-3 py-1.5 text-sm transition-colors hover:border-input",
                    choice.bitrateMbps && "border-primary bg-primary/10"
                  )}
                >
                  <Input
                    type="number"
                    inputMode="decimal"
                    min={0.5}
                    max={MAX_MBPS}
                    step={0.5}
                    placeholder="Mbps"
                    aria-label="Bitrate in megabits per second"
                    className="h-6 w-16 px-1.5 text-sm"
                    value={mbpsText}
                    onChange={(e) => {
                      setMbpsText(e.target.value);
                      const v = Math.min(Number(e.target.value), MAX_MBPS);
                      set({ bitrateMbps: v > 0 ? v : undefined });
                    }}
                  />
                  <span className="text-[11px] text-muted-foreground">Mbps</span>
                </label>
              </Choice>
            )}
            <Choice label="Audio">
              {EXPORT_AUDIO.map((a) => (
                <Pill
                  key={a.id}
                  checked={settings.audioCodec === a.id}
                  onClick={() => set({ audioCodec: a.id, ...(a.id === "pcm" ? { container: "mov" } : {}) })}
                  title={a.label}
                  detail={a.detail}
                />
              ))}
            </Choice>
          </div>
        )}

        <DialogFooter className="flex-col gap-2 sm:flex-col">
          <div className="flex items-center justify-between text-xs text-muted-foreground">
            <span>
              {settings.width} × {settings.height} · {settings.fps} fps · {settings.container.toUpperCase()} ·{" "}
              {codecLabel} + {settings.audioCodec.toUpperCase()}
            </span>
            <span className="tabular-nums">
              {formatSizeEstimate(estimateExportBytes(settings, duration))}
            </span>
          </div>
          <Button className="w-full" onClick={run}>
            Export video
          </Button>
          <p className="text-center text-[11px] text-muted-foreground">
            {inTab
              ? "Renders in the background. You can keep editing, open another project, or export more — each shows in the corner."
              : `This browser can't encode ${prores ? "ProRes" : "this"} itself, so it renders in the cloud and lands here when done.`}
          </p>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** The most a typed bitrate can ask for. */
const MAX_MBPS = 200;

function Choice({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5" role="radiogroup" aria-label={label}>
      <span className="text-xs font-medium text-muted-foreground">{label}</span>
      <div className="flex flex-wrap gap-1.5">{children}</div>
    </div>
  );
}

function Pill({
  checked,
  disabled,
  onClick,
  title,
  detail,
}: {
  checked: boolean;
  disabled?: boolean;
  onClick: () => void;
  title: string;
  detail?: string;
}) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={checked}
      disabled={disabled}
      className={cn(
        "flex min-w-[4.5rem] flex-col items-start rounded-lg border border-border bg-background px-3 py-1.5 text-left transition-colors hover:border-input disabled:cursor-not-allowed disabled:opacity-40",
        checked && "border-primary bg-primary/10"
      )}
      onClick={onClick}
    >
      <span className="text-sm font-medium">{title}</span>
      {detail && <span className="text-[11px] text-muted-foreground">{detail}</span>}
    </button>
  );
}
