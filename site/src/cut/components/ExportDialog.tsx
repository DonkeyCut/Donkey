"use client";

import { useEffect, useMemo, useState } from "react";
import { ChevronDown } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Slider } from "@/components/ui/slider";
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
  type ExportCodec,
  type ExportContainer,
} from "@/cut/lib/exportClient";
import { useCutMode } from "@/cut/lib/backend/hooks";
import { canRenderInBrowser } from "@/cut/lib/exportRender";
import { useExports } from "@/cut/lib/exportStore";
import { projectDuration, useEditor } from "@/cut/lib/store";
import { cn } from "@/lib/utils";

/** A file format the menu offers: a container carrying a codec. MP4 cannot
 * carry ProRes, so that pairing is left out. */
const FORMATS = EXPORT_CONTAINERS.flatMap((c) =>
  EXPORT_CODECS.filter((k) => !(c.id === "mp4" && k.id === "prores")).map((k) => ({
    id: `${c.id}-${k.id}`,
    container: c.id as ExportContainer,
    codec: k.id as ExportCodec,
    label: `${c.label} (${k.label})`,
    detail: k.detail,
  }))
);

/** The quality tiers in slider order, lightest on the left. */
const QUALITY_RUNGS = [...EXPORT_QUALITIES].reverse();

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
  // The size rungs in slider order, smallest on the left, source on the right.
  const rungs = useMemo(() => [...resolutions].reverse(), [resolutions]);
  const [choice, setChoice] = useState<ExportChoice>(EXPORT_QUICK_PRESETS[1].choice);
  // The field's own text, so a decimal in progress ("1.") survives the parse.
  const [mbpsText, setMbpsText] = useState("");
  // Custom is a tile of its own: picked by click, it stays lit whatever the
  // options add up to, until a preset tile is clicked.
  const [customPicked, setCustomPicked] = useState(false);
  const [moreOpen, setMoreOpen] = useState(false);
  const preset = customPicked ? null : quickPresetOf(choice, resolutions);
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

  const sizeEstimate = formatSizeEstimate(estimateExportBytes(settings, duration));
  const prores = settings.codec === "prores";
  const resolution = resolveResolution(resolutions, choice.resolution);
  const rungIndex = Math.max(0, rungs.findIndex((r) => r.id === resolution.id));
  const qualityIndex = Math.max(0, QUALITY_RUNGS.findIndex((q) => q.id === choice.quality));
  const customRate = !prores && !!choice.bitrateMbps;
  // The format the choice adds up to, once the container has been fitted to
  // what the codec and audio need.
  const formatId = `${settings.container}-${settings.codec}`;

  return (
    <Dialog open onOpenChange={(o) => !o && setExportOpen(false)}>
      <DialogContent className="top-[18%] translate-y-0 gap-0 p-0 sm:max-w-lg">
        <DialogHeader className="px-6 pt-6 pb-4">
          <DialogTitle className="text-xl">Export</DialogTitle>
        </DialogHeader>

        <DialogBody className="mx-0 my-0 flex flex-col gap-6 px-6 pt-1 pb-6">
          <div className="grid grid-cols-5 gap-1.5 max-sm:grid-cols-3" role="radiogroup" aria-label="Export preset">
            {EXPORT_QUICK_PRESETS.map((p) => (
              <PresetTile
                key={p.id}
                checked={preset === p.id}
                label={p.label}
                title={p.detail}
                onClick={() => {
                  setMbpsText("");
                  setCustomPicked(false);
                  setChoice({ ...p.choice });
                }}
              />
            ))}
            <PresetTile
              checked={preset === null}
              label="Custom"
              title="Set every option yourself"
              onClick={() => setCustomPicked(true)}
            />
          </div>

          <Scale
            label="Resolution"
            value={`${settings.width} × ${settings.height}`}
            index={rungIndex}
            stops={rungs.map((r) => ({ label: r.label, title: `${r.width} × ${r.height}` }))}
            onIndex={(i) => set({ resolution: rungs[i]!.id })}
          />

          {/* ProRes fixes its own bitrate, so the scale stays put and greys out. */}
          <Scale
            label="Quality"
            value={customRate ? `${choice.bitrateMbps} Mbps · ${sizeEstimate}` : sizeEstimate}
            index={customRate ? null : qualityIndex}
            disabled={prores}
            stops={QUALITY_RUNGS.map((q) => ({ label: q.label, title: q.detail }))}
            onIndex={(i) => {
              setMbpsText("");
              set({ quality: QUALITY_RUNGS[i]!.id, bitrateMbps: undefined });
            }}
          />

          <div className="flex flex-col gap-3">
            <Field label="Frame rate">
              <Select value={String(choice.fps)} onValueChange={(v) => set({ fps: Number(v) })}>
                <SelectTrigger className="w-32" aria-label="Frame rate">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent align="end">
                  {EXPORT_FRAME_RATES.map((f) => (
                    <SelectItem key={f} value={String(f)}>
                      {f} fps
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
            <Field label="Format">
              <Select
                value={formatId}
                onValueChange={(v) => {
                  const f = FORMATS.find((x) => x.id === v);
                  if (!f) return;
                  if (f.codec === "prores") setMbpsText("");
                  set({
                    container: f.container,
                    codec: f.codec,
                    ...(f.codec === "prores" ? { bitrateMbps: undefined } : {}),
                    // MP4 cannot carry PCM either; picking it turns the audio to AAC.
                    ...(f.container === "mp4" && choice.audioCodec === "pcm" ? { audioCodec: "aac" } : {}),
                  });
                }}
              >
                <SelectTrigger className="w-fit min-w-32" aria-label="Format">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent align="end">
                  {FORMATS.map((f) => (
                    <SelectItem key={f.id} value={f.id} title={f.detail}>
                      {f.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
            <Field label="Audio">
              <Select
                value={choice.audioCodec}
                onValueChange={(v) =>
                  set({
                    audioCodec: v as ExportChoice["audioCodec"],
                    ...(v === "pcm" ? { container: "mov" } : {}),
                  })
                }
              >
                <SelectTrigger className="w-32" aria-label="Audio">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent align="end">
                  {EXPORT_AUDIO.map((a) => (
                    <SelectItem key={a.id} value={a.id} title={a.detail}>
                      {a.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
          </div>

          <Collapsible open={moreOpen} onOpenChange={setMoreOpen} className="flex flex-col gap-3">
            <CollapsibleTrigger className="flex items-center justify-between text-sm text-muted-foreground transition-colors hover:text-foreground">
              More settings
              <ChevronDown className={cn("size-4 transition-transform", moreOpen && "rotate-180")} />
            </CollapsibleTrigger>
            <CollapsibleContent className="flex flex-col gap-3">
              <Field
                label="Custom bitrate"
                hint="Higher bitrates mean better quality and larger files. Use it when a platform requires a specific bitrate; ProRes sets its own."
              >
                <label
                  className={cn(
                    "flex h-8 items-center gap-1 rounded-lg border border-input pr-2.5 pl-2.5",
                    prores && "cursor-not-allowed opacity-40"
                  )}
                >
                  <Input
                    type="number"
                    inputMode="decimal"
                    min={0.5}
                    max={MAX_MBPS}
                    step={0.5}
                    placeholder="Auto"
                    aria-label="Bitrate in megabits per second"
                    disabled={prores}
                    className="h-6 w-16 border-0 bg-transparent px-0 text-sm shadow-none [appearance:textfield] focus-visible:ring-0 disabled:cursor-not-allowed [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
                    value={mbpsText}
                    onChange={(e) => {
                      setMbpsText(e.target.value);
                      const v = Math.min(Number(e.target.value), MAX_MBPS);
                      set({ bitrateMbps: v > 0 ? v : undefined });
                    }}
                  />
                  <span className="text-xs text-muted-foreground">Mbps</span>
                </label>
              </Field>
            </CollapsibleContent>
          </Collapsible>

          {!inTab && (
            <p className="text-xs leading-relaxed text-muted-foreground">
              This browser can&apos;t encode {prores ? "ProRes" : "this"} itself, so it renders in the
              cloud and lands here when done.
            </p>
          )}
        </DialogBody>

        <DialogFooter className="mx-0 mb-0 flex-col gap-3 rounded-b-xl bg-muted/40 px-6 py-5 sm:flex-col">
          <div className="flex items-center justify-between gap-3 text-sm text-muted-foreground">
            <span className="truncate">
              {settings.width} × {settings.height} · {settings.fps} fps ·{" "}
              {FORMATS.find((f) => f.id === formatId)?.label ?? formatId} · {settings.audioCodec.toUpperCase()}
            </span>
            <span className="shrink-0 tabular-nums">{sizeEstimate}</span>
          </div>
          <Button className="h-11 w-full text-base" onClick={run}>
            Export video
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** The most a typed bitrate can ask for. */
const MAX_MBPS = 200;

// One preset in the row across the top: its name, with what it stands for
// in the tooltip. "Custom" is the tile that lights when the options match no
// preset, and the one a click lands on to start from the options as they are.
function PresetTile({
  checked,
  label,
  title,
  onClick,
}: {
  checked: boolean;
  label: string;
  title?: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={checked}
      title={title}
      className={cn(
        "flex h-8 min-w-0 items-center justify-center rounded-lg border px-2 text-sm font-medium whitespace-nowrap transition-colors",
        checked
          ? "border-primary bg-primary/10 text-foreground"
          : "border-transparent bg-muted/60 text-muted-foreground hover:bg-muted hover:text-foreground"
      )}
      onClick={onClick}
    >
      {label}
    </button>
  );
}

/**
 * A slider over a few named stops: the label on the left, what the pick
 * adds up to on the right, and the stop names under the track, each one a
 * click away. `index` null means the value sits off the scale (a typed
 * bitrate), so no stop lights.
 */
function Scale({
  label,
  value,
  index,
  stops,
  disabled,
  onIndex,
}: {
  label: string;
  value: string;
  index: number | null;
  stops: { label: string; title?: string }[];
  disabled?: boolean;
  onIndex: (i: number) => void;
}) {
  const last = Math.max(0, stops.length - 1);
  return (
    <div className={cn("flex flex-col gap-1", disabled && "opacity-40")}>
      <div className="flex items-center justify-between gap-3">
        <span className="text-sm">{label}</span>
        <span className="truncate text-sm tabular-nums text-muted-foreground">{value}</span>
      </div>
      <Slider
        aria-label={label}
        min={0}
        max={last}
        step={1}
        disabled={disabled || stops.length < 2}
        value={index ?? 0}
        onValueChange={(v) => onIndex(Array.isArray(v) ? v[0]! : v)}
      />
      <div className="relative h-4" role="radiogroup" aria-label={`${label} presets`}>
        {stops.map((s, i) => (
          <button
            key={s.label}
            type="button"
            role="radio"
            aria-checked={index === i}
            title={s.title}
            disabled={disabled}
            className={cn(
              "absolute top-0 text-xs whitespace-nowrap transition-colors",
              i === 0 ? "left-0" : i === last ? "right-0" : "-translate-x-1/2",
              index === i ? "text-foreground" : "text-muted-foreground hover:text-foreground"
            )}
            style={i === 0 || i === last ? undefined : { left: `${(i / last) * 100}%` }}
            onClick={() => onIndex(i)}
          >
            {s.label}
          </button>
        ))}
      </div>
    </div>
  );
}

// A labeled control on one line: the name on the left, the menu on the
// right, and an explanation under it when the control needs one.
function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center justify-between gap-3">
        <span className="text-sm">{label}</span>
        {children}
      </div>
      {hint && <p className="text-xs leading-relaxed text-muted-foreground">{hint}</p>}
    </div>
  );
}
