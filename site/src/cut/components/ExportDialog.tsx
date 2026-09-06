"use client";

import { useEffect, useMemo, useState } from "react";
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
      <DialogContent className="gap-0 p-0 sm:max-w-3xl">
        <DialogHeader className="px-6 pt-6 pb-4">
          <DialogTitle className="text-xl">Export</DialogTitle>
        </DialogHeader>

        <div className="grid border-b border-border sm:grid-cols-[minmax(0,17rem)_1fr]">
          <div
            className="flex flex-col gap-0.5 px-6 pb-6 max-sm:border-b max-sm:border-border sm:border-r sm:border-border"
            role="radiogroup"
            aria-label="Export preset"
          >
            {EXPORT_QUICK_PRESETS.map((p) => (
              <PresetRow
                key={p.id}
                checked={preset === p.id}
                label={p.label}
                detail={p.short}
                title={p.detail}
                onClick={() => {
                  setMbpsText("");
                  setChoice({ ...p.choice });
                }}
              />
            ))}
            <PresetRow checked={preset === null} label="Custom" />
          </div>

          <div className="grid grid-cols-[auto_1fr] content-start items-center gap-x-4 gap-y-2 px-6 pb-6 max-sm:pt-6">
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
                <Pill key={f} checked={choice.fps === f} onClick={() => set({ fps: f })} title={String(f)} />
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
                <label className={cn(PILL, "w-[6.5rem]", choice.bitrateMbps && "border-primary bg-primary/10")}>
                  <Input
                    type="number"
                    inputMode="decimal"
                    min={0.5}
                    max={MAX_MBPS}
                    step={0.5}
                    placeholder="Mbps"
                    aria-label="Bitrate in megabits per second"
                    className="h-6 w-full border-0 bg-transparent px-0 text-sm shadow-none focus-visible:ring-0"
                    value={mbpsText}
                    onChange={(e) => {
                      setMbpsText(e.target.value);
                      const v = Math.min(Number(e.target.value), MAX_MBPS);
                      set({ bitrateMbps: v > 0 ? v : undefined });
                    }}
                  />
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
        </div>

        <DialogFooter className="flex-col gap-3 rounded-b-xl bg-muted/40 px-6 py-5 sm:flex-col">
          <div className="flex items-center justify-between text-sm text-muted-foreground">
            <span>
              {settings.width} × {settings.height} · {settings.fps} fps · {settings.container.toUpperCase()} ·{" "}
              {codecLabel} + {settings.audioCodec.toUpperCase()}
            </span>
            <span className="tabular-nums">
              {formatSizeEstimate(estimateExportBytes(settings, duration))}
            </span>
          </div>
          <Button className="h-11 w-full text-base" onClick={run}>
            Export video
          </Button>
          <p className="text-center text-xs text-muted-foreground">
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

/** One option in a row: every pill is the same height, label only; the detail rides the tooltip. */
const PILL =
  "flex h-9 items-center rounded-lg border border-border bg-background px-3.5 text-sm transition-colors hover:border-input";

// One preset in the left pane: the name, and what it stands for on the right.
// "Custom" has no click: it is the row that lights when the options match no preset.
function PresetRow({
  checked,
  label,
  detail,
  title,
  onClick,
}: {
  checked: boolean;
  label: string;
  detail?: string;
  title?: string;
  onClick?: () => void;
}) {
  const className = cn(
    "flex h-11 items-center justify-between rounded-lg px-4 text-left transition-colors",
    onClick && "hover:bg-muted/60",
    checked && "bg-muted"
  );
  const body = (
    <>
      <span className="text-sm font-medium">{label}</span>
      {detail && <span className="text-xs text-muted-foreground">{detail}</span>}
    </>
  );
  if (!onClick) return <div className={className}>{body}</div>;
  return (
    <button type="button" role="radio" aria-checked={checked} title={title} className={className} onClick={onClick}>
      {body}
    </button>
  );
}

// A row of the options grid: the label sits in the first column, the pills
// fill the second, so every row's pills start on the same line.
function Choice({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <>
      <span className="text-sm text-muted-foreground">{label}</span>
      <div className="flex flex-wrap gap-1.5" role="radiogroup" aria-label={label}>
        {children}
      </div>
    </>
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
      title={detail}
      className={cn(
        PILL,
        "font-medium disabled:cursor-not-allowed disabled:opacity-40",
        checked && "border-primary bg-primary/10"
      )}
      onClick={onClick}
    >
      {title}
    </button>
  );
}
