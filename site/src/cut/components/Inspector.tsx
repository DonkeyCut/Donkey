"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { AlignCenter, AlignHorizontalSpaceAround, AlignLeft, AlignRight, AlignVerticalSpaceAround, Bold, ChevronLeft, ChevronRight, Diamond, Frame, Italic, Loader2, Palette, Scissors, Smile, Trash2, Type, Volume2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { EmojiPicker } from "@/cut/components/EmojiPicker";
import { FontPicker } from "@/cut/components/FontPicker";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import {
  EFFECT_LABELS,
  hasMaskKeys,
  hasOverlayAnim,
  hasOverlayKeys,
  KEY_EPSILON,
  keyIndexAt,
  lineLikeShape,
  maskFrameAt,
  poseAt,
  type Mask,
  type MaskKey,
  type MaskKind,
  type OverlayKey,
  OVERLAY_ANIM_DEFAULT_SECONDS,
  OVERLAY_ANIM_MAX_SECONDS,
  OVERLAY_ANIM_MIN_SECONDS,
  ZOOM_LEVELS,
  ZOOM_RAMP_MAX,
  zoomRampOf,
  wordAccent,
  wordDim,
  wordEffect,
  wordKnobs,
  WORD_ACCENT_DEFAULT,
  WORD_POP_SCALE,
  WORD_SWELL_MAX,
  WORD_SWELL_MIN,
  wordSwell,
  type OverlayAnim,
  type OverlayAnimStyle,
  type OverlayLoopStyle,
  type WordEffectId,
} from "@donkeycut/effects-kit";
import { clipWindow, useEditor, type EditorState } from "@/cut/lib/store";
import { usePanelView } from "@/cut/lib/panelViews";
import { usePreviewTime } from "@/cut/lib/playhead";
import { CLIP_MAX_ZOOM, clipCovers, clipKeyed, clipPoseAt, clipZoom, contentRect } from "@/cut/lib/types";
import { AnimationCard, AnimationTiles } from "@/cut/components/AnimationTiles";
import { ColorField } from "@/cut/components/ColorField";
import { wordTimesFor } from "@/cut/lib/textWords";
import { NumberField } from "@/cut/components/NumberField";
import { playAnimPreview, stopAnimPreview } from "@/cut/lib/animPreview";
import { GenerateSubtitlesAudio } from "@/cut/components/VoicePicker";
import {
  parseNumberInput,
  parsePercentInput,
  parseSecondsInput,
  parseSpeedInput,
  parseTimeInput,
  ScrubValue,
} from "@/cut/components/ScrubValue";
import { ValueSlider } from "@/cut/components/ValueSlider";
import { PLATE_COLOR, PLATE_OPACITY, PLATE_RADIUS, plateFill } from "@/cut/lib/textRender";
import {
  deleteStylePreset,
  listStylePresets,
  saveStylePreset,
  type StylePreset,
} from "@/cut/lib/stylePresets";
import { writeTextStyle } from "@/cut/lib/textStyle";
import { formatTime } from "@/cut/lib/time";
import {
  fontStack,
  frameOf,
  isEffectOverlay,
  isShapeOverlay,
  isTextOverlay,
  LAYOUTS,
  onFontsChanged,
  rectOf,
  regionLabel,
  SHAPE_LABELS,
  SPEED_FLOOR,
  SPEED_MAX,
  SPEED_MIN,
  assetIsSilent,
  clampOverlayPos,
  type AudioClip,
  type BoxStyle,
  type ClipShadow,
  type FrameRect,
  type LayoutId,
  type EffectOverlay,
  type MediaAsset,
  type Overlay,
  type ShapeOverlay,
  type StickerOverlay,
  type TextOverlay,
  type VideoClip,
} from "@/cut/lib/types";
import { beatsBusyFor, detectAssetBeats, subscribeBeatsBusy } from "@/cut/lib/media";
import { reportSwallowed } from "@/cut/lib/report";
import {
  MOVE_STRENGTH_MAX,
  MOVE_STRENGTH_MIN,
  MOVE_STRENGTH_STEP,
} from "@/cut/lib/textMotion";
import { getPreviewCanvas } from "@/cut/lib/previewCanvas";
import { cn } from "@/lib/utils";
import { ScrollArea } from "@/components/ui/scroll-area";
import { InfoTip, ResetButton, Row, Section, useSliderCheckpoint, Value } from "@/cut/components/panelBits";
import { ColorPanel } from "@/cut/components/ColorPanel";
import { RemovalPanel } from "@/cut/components/RemovalPanel";
import { useMatteBakes } from "@/cut/lib/removal/bakeJobs";

/** Where the animation panel is, for the panel that offers the way in. It is
 * held by the Inspector rather than by each panel because the animation panel
 * replaces the whole column, scroller included: it lays out its own bands, and
 * a band that must not move cannot sit inside something that scrolls. */
type AnimNav = { view: "closed" | "open" | "returned"; open: () => void; back: () => void };
const AnimNavContext = createContext<AnimNav>({
  view: "closed",
  open: () => {},
  back: () => {},
});
const useAnimNav = () => useContext(AnimNavContext);

export function Inspector() {
  const selection = useEditor((s) => s.selection);
  const clip = useEditor((s) =>
    selection?.kind === "clip" ? s.clips.find((c) => c.id === selection.id) : undefined
  );
  const audio = useEditor((s) =>
    selection?.kind === "audio" ? s.audioClips.find((c) => c.id === selection.id) : undefined
  );
  const overlay = useEditor((s) =>
    selection?.kind === "overlay" ? s.overlays.find((o) => o.id === selection.id) : undefined
  );

  return (
    <aside data-field-panel="" className="flex min-h-0 flex-col border-l border-border bg-card">
      {/* Keyed on what is selected: picking something else builds a fresh
          column, so it opens on that thing's own fields. */}
      <InspectorColumn
        key={selection?.id ?? "none"}
        clip={clip}
        audio={audio}
        overlay={overlay}
      />
    </aside>
  );
}

function InspectorColumn({
  clip,
  audio,
  overlay,
}: {
  clip?: VideoClip;
  audio?: AudioClip;
  overlay?: Overlay;
}) {
  // Whether the Animations view is open holds for the session per overlay,
  // so an overlay reselected after a look elsewhere reopens on it. The
  // transitional "returned" state stays local — it exists for scroll restore
  // on the way back, and only "open"/"closed" are worth remembering.
  const [heldAnim, setHeldAnim] = usePanelView<"open" | "closed">(
    `overlay-anim:${overlay?.id ?? "none"}`,
    "closed"
  );
  const [animView, setAnimView] = useState<"closed" | "open" | "returned">(heldAnim);
  const nav = useMemo<AnimNav>(
    () => ({
      view: animView,
      open: () => {
        setHeldAnim("open");
        setAnimView("open");
      },
      back: () => {
        setHeldAnim("closed");
        setAnimView("returned");
      },
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [animView]
  );

  if (overlay && animView === "open")
    return (
      <AnimNavContext.Provider value={nav}>
        <AnimationPanel overlay={overlay} onBack={nav.back} />
      </AnimNavContext.Provider>
    );
  if (clip) return <ClipColumn clip={clip} />;
  return (
    <AnimNavContext.Provider value={nav}>
      <ScrollArea className="min-h-0 flex-1">
        {audio ? (
          <AudioPanel clip={audio} />
        ) : overlay ? (
          isTextOverlay(overlay) ? (
            <TextPanel overlay={overlay} />
          ) : isShapeOverlay(overlay) ? (
            <ShapePanel overlay={overlay} />
          ) : isEffectOverlay(overlay) ? (
            <EffectPanel overlay={overlay} />
          ) : (
            <StickerPanel overlay={overlay} />
          )
        ) : null}
      </ScrollArea>
    </AnimNavContext.Provider>
  );
}

function PanelTitle({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex h-10 shrink-0 items-center px-3.5 text-sm font-semibold tracking-tight">
      {children}
    </div>
  );
}

/** One-line header for a media clip's panel: the file name (ellipsised, with
 * the full name in its hover tooltip) and the clip's running length. */
function ClipHead({ name, time }: { name?: string; time: string }) {
  return (
    <div className="mb-1.5 flex h-10 shrink-0 items-center justify-between gap-2 border-b border-border">
      <div className="min-w-0 truncate text-sm font-semibold tracking-tight" title={name}>
        {name}
      </div>
      <Value className="shrink-0 text-muted-foreground">{time}</Value>
    </div>
  );
}

/** A control that carries its own caption, for the two-up rows where the
 * settings sit side by side instead of behind a label on the left. */
function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <span className="truncate text-[11px] text-muted-foreground">{label}</span>
      {children}
    </div>
  );
}

/** Icon toggles that belong together, sat in one trough. */
function SegGroup({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex shrink-0 items-center gap-0.5 rounded-md bg-secondary/60 p-0.5">
      {children}
    </div>
  );
}

function SegToggle({
  label,
  active,
  onClick,
  children,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      aria-pressed={active}
      className={cn(
        "grid size-6 place-items-center rounded-[5px] text-muted-foreground transition-colors [&_svg]:size-3.5",
        active ? "bg-foreground text-background" : "hover:bg-foreground/10 hover:text-foreground"
      )}
      onClick={onClick}
    >
      {children}
    </button>
  );
}


/** Matches the store's MIN_LEN: the shortest a trim can leave a clip. */
const MIN_TRIM = 0.1;

const formatSpeed = (v: number) => `${v.toFixed(2)}×`;
const formatPercent = (v: number) => `${Math.round(v * 100)}%`;

/** One-click frame layouts (Full / Top / Bottom / Left / Right / PiP) shared by
 * the video-clip and overlay-clip panels. Picking one regions the clip so two
 * videos can share the frame; "Full" clears the region. */
/** The clip's box narrowed to the source's own shape: the picture area a fit
 * clip already draws inside `rect`, which is the box that shows the whole shot
 * with no margins around it. */
function sourceAspectRect(
  rect: FrameRect,
  srcW: number,
  srcH: number,
  frame: { w: number; h: number }
): FrameRect {
  const px = contentRect(
    { x: rect.x * frame.w, y: rect.y * frame.h, w: rect.w * frame.w, h: rect.h * frame.h },
    srcW,
    srcH,
    false
  );
  return { x: px.x / frame.w, y: px.y / frame.h, w: px.w / frame.w, h: px.h / frame.h };
}

function LayoutButtons({
  rect,
  onPick,
  onSourceAspect,
}: {
  rect: FrameRect;
  onPick: (frame: FrameRect | undefined, fit: "fit" | "fill") => void;
  /** Narrow the box to the source's own shape, dropping the margins. */
  onSourceAspect?: () => void;
}) {
  const currentId =
    (Object.keys(LAYOUTS) as LayoutId[]).find((id) => LAYOUTS[id].label === regionLabel(rect)) ??
    "full";
  return (
    <>
    <div className="flex items-center justify-between gap-2 py-1">
      <span className="text-[11.5px] font-medium text-muted-foreground">Layout</span>
      <Select
        value={currentId}
        items={Object.fromEntries((Object.keys(LAYOUTS) as LayoutId[]).map((id) => [id, LAYOUTS[id].label]))}
        onValueChange={(id) => {
          const L = LAYOUTS[id as LayoutId];
          onPick(id === "full" ? undefined : { ...L.rect }, L.fit);
        }}
      >
        <SelectTrigger className="h-8 w-36 text-[12px]">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {(Object.keys(LAYOUTS) as LayoutId[]).map((id) => (
            <SelectItem key={id} value={id} className="text-[12px]">
              {LAYOUTS[id].label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
    {onSourceAspect && (
      <Row label="Shape">
        <button
          className="clip-source-aspect rounded-md border border-input px-2 py-0.5 text-[11.5px] text-muted-foreground transition-colors hover:text-foreground"
          onClick={onSourceAspect}
        >
          Match source
        </button>
      </Row>
    )}
    </>
  );
}

/** The clip column's floor toolbar: the three deep views, each an icon over
 * its name. The open view's button reads dark and pressing it again returns
 * to the main settings. */
const CLIP_TABS = [
  { id: "color", label: "Color", Icon: Palette },
  { id: "cutout", label: "Cutout", Icon: Scissors },
  { id: "frame", label: "Frame", Icon: Frame },
  { id: "audio", label: "Audio", Icon: Volume2 },
] as const;
type ClipTab = (typeof CLIP_TABS)[number]["id"] | "main";

/**
 * The video clip's column: the main settings with the Color, Frame, and Audio
 * views behind a toolbar pinned under the scroller, so it stays put whichever
 * view is open. Color lays out its own bands around its own scroller; the
 * others ride the column's. The open view holds for the session per clip, so
 * deselecting to look at something and coming back lands this clip on its
 * own view; a clip whose panel was never opened starts at the main one.
 */
function ClipColumn({ clip }: { clip: VideoClip }) {
  const [tab, setTab] = usePanelView<ClipTab>(`clip-tab:${clip.id}`, "main");
  const back = () => setTab("main");
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {tab === "color" ? (
        <ColorPanel clip={clip} onBack={back} />
      ) : tab === "cutout" ? (
        <RemovalPanel clip={clip} onBack={back} />
      ) : (
        <ScrollArea className="min-h-0 flex-1">
          {tab === "frame" ? (
            <ClipFramePanel clip={clip} onBack={back} />
          ) : tab === "audio" ? (
            <ClipAudioPanel clip={clip} onBack={back} />
          ) : (
            <ClipPanel clip={clip} />
          )}
        </ScrollArea>
      )}
      <ClipToolbar clipId={clip.id} tab={tab} onPick={(t) => setTab(tab === t ? "main" : t)} />
    </div>
  );
}

function ClipToolbar({
  clipId,
  tab,
  onPick,
}: {
  clipId: string;
  tab: ClipTab;
  onPick: (tab: Exclude<ClipTab, "main">) => void;
}) {
  // A running matte bake shows on the Cutout tab itself, so the work stays
  // visible from any view.
  const baking = useMatteBakes((s) => s.jobs[clipId]?.status === "running");
  return (
    <div className="flex shrink-0 border-t border-border bg-card">
      {CLIP_TABS.map(({ id, label, Icon }) => (
        <button
          key={id}
          type="button"
          aria-pressed={tab === id}
          className={cn(
            `clip-tab-${id} relative flex flex-1 flex-col items-center justify-center gap-0.5 py-1 text-[10px] leading-none font-medium transition-colors`,
            tab === id
              ? "bg-neutral-900 text-white"
              : "text-muted-foreground hover:bg-foreground/5 hover:text-foreground"
          )}
          onClick={() => onPick(id)}
        >
          <Icon className="size-3.5" strokeWidth={tab === id ? 2.25 : 2} />
          {label}
          {id === "cutout" && baking && (
            <Loader2 className="absolute top-1 right-1.5 size-2.5 animate-spin" />
          )}
        </button>
      ))}
    </div>
  );
}

/** Header for a toolbar view: the back chevron and the view's name, the same
 * band the Color view opens with. */
function SubviewHead({ title, onBack }: { title: string; onBack: () => void }) {
  return (
    <div className="flex h-10 shrink-0 items-center gap-1 px-2.5 text-sm font-semibold tracking-tight">
      <button
        type="button"
        aria-label="Back"
        className="grid size-6 place-items-center rounded text-muted-foreground transition-colors hover:text-foreground"
        onClick={onBack}
      >
        <ChevronLeft className="size-4" />
      </button>
      {title}
    </div>
  );
}

/** The Frame view: what the clip's box does — its pose keyframes, border,
 * shadow, and mask. */
function ClipFramePanel({ clip, onBack }: { clip: VideoClip; onBack: () => void }) {
  return (
    <>
      <SubviewHead title="Frame" onBack={onBack} />
      <div className="flex flex-col gap-1 px-3.5 pb-4">
        <ClipTransformSection clip={clip} />
        <ClipBorderSection clip={clip} />
        <ClipShadowSection clip={clip} />
        <ClipMaskSection clip={clip} />
      </div>
    </>
  );
}

/** The Audio view: the clip's own sound and the generated voice laid over it. */
function ClipAudioPanel({ clip, onBack }: { clip: VideoClip; onBack: () => void }) {
  const asset = useEditor((s) => s.assets.find((a) => a.id === clip.assetId));
  const updateClip = useEditor((s) => s.updateClip);
  const [volumeDraft, setVolumeDraft] = useState<number | null>(null);
  const volume = volumeDraft ?? clip.volume ?? 1;
  return (
    <>
      <SubviewHead title="Audio" onBack={onBack} />
      <div className="flex flex-col gap-1 px-3.5 pb-4">
        <Row label="Volume">
          <ValueSlider
            label="Volume"
            sliderClassName="clip-volume data-horizontal:w-24"
            valueClassName="w-9 text-muted-foreground"
            value={volume}
            min={0}
            max={3}
            step={0.05}
            snap={[1]}
            format={formatPercent}
            parse={parsePercentInput}
            onDraft={setVolumeDraft}
            onCommit={(v) => {
              updateClip(clip.id, { volume: v === 1 ? undefined : v });
              setVolumeDraft(null);
            }}
          />
        </Row>
        <Row label="Mute audio">
          <Switch
            checked={clip.muted}
            onCheckedChange={(v) => updateClip(clip.id, { muted: v })}
          />
        </Row>
        {asset && !assetIsSilent(asset) && (
          <Row
            label="Beats"
            info="Beat markers detected from the clip's sound, drawn as dots along its bar. Every drag and trim snaps to them; drag a dot to move it, double-click removes it, ⌥-click the clip adds one."
          >
            <BeatsControl asset={asset} />
          </Row>
        )}
        <ClipGeneratedAudio clip={clip} />
      </div>
    </>
  );
}

function ClipPanel({ clip }: { clip: VideoClip }) {
  const asset = useEditor((s) => s.assets.find((a) => a.id === clip.assetId));
  const aspect = useEditor((s) => s.aspect);
  const updateClip = useEditor((s) => s.updateClip);
  const zoomCk = useSliderCheckpoint();
  const panCk = useSliderCheckpoint();
  const turnCk = useSliderCheckpoint();
  const fadeCk = useSliderCheckpoint();
  const [speedDraft, setSpeedDraft] = useState<number | null>(null);
  const speed = speedDraft ?? clip.speed ?? 1;
  const speedLen = (clip.out - clip.in) / (speed > 0 ? speed : 1);
  // Typing can trim out to the source's end but no further; an image has no
  // intrinsic duration, so its clip can be any length.
  const maxOut = asset && asset.type !== "image" ? asset.duration : Infinity;
  // The Shape row shows only while snugging the box to the footage's shape
  // would move it, so the button always visibly does something.
  const rect = rectOf(clip);
  const snug =
    asset?.width && asset?.height
      ? sourceAspectRect(rect, asset.width, asset.height, frameOf(aspect))
      : null;
  const snugMoves =
    !!snug && (["x", "y", "w", "h"] as const).some((k) => Math.abs(snug[k] - rect[k]) > 1e-3);
  // Which axes the crop window can travel on: the picture hangs past the box
  // there, so pan has somewhere to go. Measured in frame pixels, the same
  // geometry the preview's grey outline draws.
  const frPx = frameOf(aspect);
  const boxPx = { x: rect.x * frPx.w, y: rect.y * frPx.h, w: rect.w * frPx.w, h: rect.h * frPx.h };
  const picPx =
    asset?.width && asset?.height
      ? contentRect(
          boxPx,
          asset.width,
          asset.height,
          clipCovers(clip),
          clipZoom(clip),
          clip.panX ?? 0,
          clip.panY ?? 0
        )
      : boxPx;
  const panXFree = picPx.w - boxPx.w > 1;
  const panYFree = picPx.h - boxPx.h > 1;
  return (
    <>
      <div className="flex flex-col gap-1 px-3.5 pb-4">
        <ClipHead name={asset?.name} time={formatTime(speedLen)} />
        <Row label="Trim">
          <ScrubValue
            label="Trim start"
            value={clip.in}
            min={0}
            max={clip.out - MIN_TRIM}
            step={0.1}
            keyStep={1}
            format={formatTime}
            parse={parseTimeInput}
            onCommit={(v) => useEditor.getState().setClipTrim(clip.id, v, clip.out)}
          />
          <Value className="text-muted-foreground">–</Value>
          <ScrubValue
            label="Trim end"
            value={clip.out}
            min={clip.in + MIN_TRIM}
            max={maxOut}
            step={0.1}
            keyStep={1}
            format={formatTime}
            parse={parseTimeInput}
            onCommit={(v) => useEditor.getState().setClipTrim(clip.id, clip.in, v)}
          />
          <ResetButton
            title="Reset trim"
            show={Number.isFinite(maxOut) && (clip.in > 1e-3 || clip.out < maxOut - 1e-3)}
            onClick={() => useEditor.getState().setClipTrim(clip.id, 0, maxOut)}
          />
        </Row>
        <Row label="Starts at">
          <ScrubValue
            label="Starts at"
            value={clip.start}
            min={0}
            max={Infinity}
            step={0.1}
            keyStep={1}
            format={formatTime}
            parse={parseTimeInput}
            onCommit={(v) => {
              updateClip(clip.id, { start: Math.max(0, v) });
              useEditor.getState().sortClips();
            }}
          />
        </Row>
        <Row label="Speed">
          <ValueSlider
            label="Speed"
            sliderClassName="clip-speed data-horizontal:w-24"
            valueClassName="w-9 text-muted-foreground"
            value={speed}
            min={SPEED_MIN}
            max={SPEED_MAX}
            step={0.05}
            snap={[1]}
            scrubMin={SPEED_FLOOR}
            scrubMax={Infinity}
            format={formatSpeed}
            parse={parseSpeedInput}
            onDraft={setSpeedDraft}
            onCommit={(v) => {
              useEditor.getState().setClipSpeed(clip.id, v);
              setSpeedDraft(null);
            }}
          />
          <ResetButton
            title="Reset speed"
            show={Math.abs(speed - 1) > 1e-4}
            onClick={() => {
              useEditor.getState().setClipSpeed(clip.id, 1);
              setSpeedDraft(null);
            }}
          />
        </Row>

        {/* Picture */}
        <div className="my-1.5 h-px bg-border" />
        <Row label="Hidden">
          <Switch
            checked={!!clip.hidden}
            onCheckedChange={(v) => updateClip(clip.id, { hidden: v })}
          />
        </Row>
        <Row label="Framing">
          <div className="clip-framing flex rounded-lg border border-input p-0.5">
            {(["fit", "fill"] as const).map((mode) => (
              <button
                key={mode}
                className={cn(
                  "rounded-md px-2.5 py-1 text-[11.5px] font-medium transition-colors",
                  (clip.fit ?? "fit") === mode
                    ? "bg-neutral-900 text-white"
                    : "text-muted-foreground hover:text-foreground"
                )}
                aria-pressed={(clip.fit ?? "fit") === mode}
                onClick={() => updateClip(clip.id, { fit: mode, panX: 0, panY: 0 })}
              >
                {mode === "fit" ? "Fit" : "Fill"}
              </button>
            ))}
          </div>
        </Row>
        <Row label="Zoom">
          <ValueSlider
            label="Zoom"
            sliderClassName="clip-zoom data-horizontal:w-24"
            valueClassName="w-9 text-muted-foreground"
            value={clipZoom(clip)}
            min={1}
            max={CLIP_MAX_ZOOM}
            step={0.01}
            snap={[1]}
            keyStep={0.05}
            format={formatPercent}
            parse={parsePercentInput}
            onDraft={(v) => {
              zoomCk.begin();
              useEditor.getState().updateClipTransient(clip.id, {
                zoom: v > 1.001 ? v : undefined,
              });
            }}
            onCommit={(v) => {
              zoomCk.begin();
              updateClip(clip.id, { zoom: v > 1.001 ? v : undefined });
              zoomCk.end();
            }}
          />
          <ResetButton
            title="Reset zoom"
            show={clipZoom(clip) > 1}
            onClick={() => updateClip(clip.id, { zoom: undefined, panX: 0, panY: 0 })}
          />
        </Row>
        {(["panX", "panY"] as const).map((axis) => {
          const free = axis === "panX" ? panXFree : panYFree;
          const value = clip[axis] ?? 0;
          if (!free && value === 0) return null;
          return (
            <Row key={axis} label={axis === "panX" ? "Pan X" : "Pan Y"}>
              <ValueSlider
                label={axis === "panX" ? "Pan X" : "Pan Y"}
                sliderClassName="clip-pan data-horizontal:w-24"
                valueClassName="w-9 text-muted-foreground"
                value={value}
                min={-1}
                max={1}
                step={0.01}
                snap={[0]}
                keyStep={0.05}
                format={formatPercent}
                parse={parsePercentInput}
                onDraft={(v) => {
                  panCk.begin();
                  useEditor.getState().updateClipTransient(clip.id, { [axis]: v });
                }}
                onCommit={(v) => {
                  panCk.begin();
                  updateClip(clip.id, { [axis]: v });
                  panCk.end();
                }}
              />
              <ResetButton
                title="Center"
                show={value !== 0}
                onClick={() => updateClip(clip.id, { [axis]: 0 })}
              />
            </Row>
          );
        })}
        <Row label="Rotation">
          <ValueSlider
            label="Rotation"
            sliderClassName="clip-rotation data-horizontal:w-24"
            valueClassName="w-9 text-muted-foreground"
            value={clip.rotation ?? 0}
            min={-180}
            max={180}
            step={1}
            snap={[-90, 0, 90]}
            format={(v) => `${Math.round(v)}°`}
            parse={parseNumberInput}
            onDraft={(v) => {
              turnCk.begin();
              useEditor.getState().updateClipTransient(clip.id, {
                rotation: Math.round(v) || undefined,
              });
            }}
            onCommit={(v) => {
              turnCk.begin();
              updateClip(clip.id, { rotation: Math.round(v) || undefined });
              turnCk.end();
            }}
          />
          <ResetButton
            title="Reset rotation"
            show={!!clip.rotation}
            onClick={() => updateClip(clip.id, { rotation: undefined })}
          />
        </Row>
        <Row label="Opacity">
          <ValueSlider
            label="Opacity"
            sliderClassName="clip-opacity data-horizontal:w-24"
            valueClassName="w-9 text-muted-foreground"
            value={clip.opacity ?? 1}
            min={0}
            max={1}
            step={0.01}
            snap={[1]}
            format={formatPercent}
            parse={parsePercentInput}
            onDraft={(v) => {
              fadeCk.begin();
              useEditor.getState().updateClipTransient(clip.id, {
                opacity: v >= 0.999 ? undefined : v,
              });
            }}
            onCommit={(v) => {
              fadeCk.begin();
              updateClip(clip.id, { opacity: v >= 0.999 ? undefined : v });
              fadeCk.end();
            }}
          />
          <ResetButton
            title="Reset opacity"
            show={(clip.opacity ?? 1) < 1}
            onClick={() => updateClip(clip.id, { opacity: undefined })}
          />
        </Row>
        <LayoutButtons
          rect={rect}
          onPick={(frame, fit) => updateClip(clip.id, { frame, fit })}
          onSourceAspect={
            snug && snugMoves
              ? () =>
                  updateClip(clip.id, {
                    frame: snug,
                    fit: "fit",
                    zoom: undefined,
                    panX: 0,
                    panY: 0,
                  })
              : undefined
          }
        />
      </div>
    </>
  );
}

/** Per-clip generated-audio block: the voice picker, "Generate audio for clip"
 * (which transcribes just this clip when it has no cues yet), and one volume
 * slider driving the voiceovers laid over the clip. Shared by every clip
 * panel on any track. */
function ClipGeneratedAudio({ clip }: { clip: VideoClip }) {
  // Subtitle cues overlapping this clip's timeline span, for the per-clip
  // readout. A selector rather than a snapshot so the generate button reads
  // fresh ids after it auto-transcribes the cut.
  const selectClipCueIds = useCallback(
    (s: EditorState) => {
      const sp = clipWindow(s.clips, s.assets, clip.id);
      if (!sp) return [];
      return s.subtitles.cues
        .filter((c) => c.text.trim() && c.end > sp.start && c.start < sp.start + sp.len)
        .map((c) => c.id);
    },
    [clip.id]
  );
  const ensureClipCues = useCallback(
    () => useEditor.getState().generateClipSubtitles(clip.id),
    [clip.id]
  );
  // Generated voiceover clips overlapping this clip's span — the "Generated
  // audio" slider drives them all, so clip sound and voiceover balance from one
  // panel. Same joined-string trick as the cue ids for reference stability.
  const [genVolDraft, setGenVolDraft] = useState<number | null>(null);
  const genCk = useSliderCheckpoint();
  const genAudioKey = useEditor((s) => {
    const sp = clipWindow(s.clips, s.assets, clip.id);
    if (!sp) return "";
    // AI-voice audio regardless of where it was made: the Audio panel tags
    // voiceovers, the chat tags its own — both are voice over this clip.
    const voiceAssets = new Set(
      s.assets
        .filter((a) => a.origin === "voiceover" || (a.origin === "chat" && a.type === "audio"))
        .map((a) => a.id)
    );
    return s.audioClips
      .filter((a) => {
        const len = (a.out - a.in) / (a.speed && a.speed > 0 ? a.speed : 1);
        return (
          voiceAssets.has(a.assetId) && a.start < sp.start + sp.len && a.start + len > sp.start
        );
      })
      .map((a) => a.id)
      .join("\n");
  });
  const genAudioIds = useMemo(() => (genAudioKey ? genAudioKey.split("\n") : []), [genAudioKey]);
  const genVolStore = useEditor((s) => {
    const first = s.audioClips.find((a) => a.id === genAudioIds[0]);
    return first ? first.volume : 1;
  });
  const genVol = genVolDraft ?? genVolStore;
  return (
    <div className="mt-2 flex flex-col gap-1 border-t border-border pt-3">
      <GenerateSubtitlesAudio
        selectCueIds={selectClipCueIds}
        ensureCues={ensureClipCues}
        label="Generate audio for clip"
      />
      {genAudioIds.length > 0 && (
        <Row label="Volume">
          <ValueSlider
            label="Generated audio volume"
            sliderClassName="clip-gen-volume data-horizontal:w-24"
            valueClassName="w-9 text-muted-foreground"
            value={genVol}
            min={0}
            max={3}
            step={0.05}
            snap={[1]}
            format={formatPercent}
            parse={parsePercentInput}
            onDraft={(v) => {
              genCk.begin();
              setGenVolDraft(v);
              const s = useEditor.getState();
              genAudioIds.forEach((id) => s.updateAudioTransient(id, { volume: v }));
            }}
            onCommit={(v) => {
              genCk.begin();
              const s = useEditor.getState();
              genAudioIds.forEach((id) => s.updateAudioTransient(id, { volume: v }));
              genCk.end();
              setGenVolDraft(null);
            }}
          />
        </Row>
      )}
    </div>
  );
}

/** The Beats row's control: detect (or re-run) the asset's beat grid, and
 * clear it. The dots themselves live on the clip bars — dragged, added
 * (⌥-click), and removed (double-click) there. */
function BeatsControl({ asset }: { asset: MediaAsset }) {
  const busy = useSyncExternalStore(subscribeBeatsBusy, () => beatsBusyFor(asset.id), () => false);
  const grid = asset.beats;
  return (
    <>
      {grid && (
        <Value className="whitespace-nowrap text-muted-foreground">
          {grid.beats.length}
          {grid.bpm > 0 ? `·${Math.round(grid.bpm)} BPM` : " beats"}
        </Value>
      )}
      <Button
        size="sm"
        variant="outline"
        disabled={busy || !!asset.upload}
        onClick={() => {
          void detectAssetBeats(asset).catch((err) => {
            reportSwallowed(`[cut] beat scan failed for ${asset.fileName}`, err);
          });
        }}
      >
        {busy && <Loader2 className="size-3.5 animate-spin" />}
        Detect
      </Button>
      <ResetButton
        title="Clear beats"
        show={!!grid}
        onClick={() => {
          useEditor.getState().pushHistory();
          useEditor.getState().updateAsset(asset.id, { beats: undefined });
        }}
      />
    </>
  );
}

function AudioPanel({ clip }: { clip: AudioClip }) {
  const asset = useEditor((s) => s.assets.find((a) => a.id === clip.assetId));
  const updateAudioTransient = useEditor((s) => s.updateAudioTransient);
  const ck = useSliderCheckpoint();
  const setAudio = (patch: Partial<AudioClip>) => {
    ck.begin();
    updateAudioTransient(clip.id, patch);
  };
  // Detached audio can carry a playback rate; its timeline length is (out-in)/speed.
  const speed = clip.speed && clip.speed > 0 ? clip.speed : 1;
  const len = (clip.out - clip.in) / speed;
  // A fade can take at most half the clip so in+out never overlap.
  const maxFade = Math.max(0.1, Math.round((len / 2) * 10) / 10);
  // Commit closes the checkpoint setAudio opened (or opens+closes one for a
  // typed entry), so any adjustment lands as a single undo step.
  const commitAudio = (patch: Partial<AudioClip>) => {
    setAudio(patch);
    ck.end();
  };
  return (
    <>
      <div className="flex flex-col gap-1 px-3.5 pb-4">
        <ClipHead name={asset?.name} time={formatTime(len)} />
        <Row label="Trim">
          <ScrubValue
            label="Trim start"
            value={clip.in}
            min={0}
            max={clip.out - MIN_TRIM}
            step={0.1}
            keyStep={1}
            format={formatTime}
            parse={parseTimeInput}
            onCommit={(v) => commitAudio({ in: v })}
          />
          <Value className="text-muted-foreground">–</Value>
          <ScrubValue
            label="Trim end"
            value={clip.out}
            min={clip.in + MIN_TRIM}
            max={asset?.duration ?? clip.out}
            step={0.1}
            keyStep={1}
            format={formatTime}
            parse={parseTimeInput}
            onCommit={(v) => commitAudio({ out: v })}
          />
          <ResetButton
            title="Reset trim"
            show={!!asset && (clip.in > 1e-3 || clip.out < asset.duration - 1e-3)}
            onClick={() => asset && commitAudio({ in: 0, out: asset.duration })}
          />
        </Row>
        <Row label="Starts at">
          <ScrubValue
            label="Starts at"
            value={clip.start}
            min={0}
            max={Infinity}
            step={0.1}
            keyStep={1}
            format={formatTime}
            parse={parseTimeInput}
            onCommit={(v) => commitAudio({ start: v })}
          />
        </Row>
        <Row label="Speed">
          <ValueSlider
            label="Speed"
            sliderClassName="audio-speed data-horizontal:w-24"
            valueClassName="w-9 text-muted-foreground"
            value={speed}
            min={SPEED_MIN}
            max={SPEED_MAX}
            step={0.05}
            snap={[1]}
            scrubMin={SPEED_FLOOR}
            scrubMax={Infinity}
            format={formatSpeed}
            parse={parseSpeedInput}
            onDraft={(v) => setAudio({ speed: Math.abs(v - 1) < 1e-4 ? undefined : v })}
            onCommit={(v) => commitAudio({ speed: Math.abs(v - 1) < 1e-4 ? undefined : v })}
          />
          <ResetButton
            title="Reset speed"
            show={Math.abs(speed - 1) > 1e-4}
            onClick={() => commitAudio({ speed: undefined })}
          />
        </Row>
        <Row label="Volume">
          <ValueSlider
            label="Volume"
            sliderClassName="data-horizontal:w-24"
            valueClassName="w-9 text-muted-foreground"
            value={clip.volume}
            min={0}
            max={3}
            step={0.05}
            snap={[1]}
            format={formatPercent}
            parse={parsePercentInput}
            onDraft={(v) => setAudio({ volume: v })}
            onCommit={(v) => commitAudio({ volume: v })}
          />
        </Row>
        <Row label="Fade in">
          <ValueSlider
            label="Fade in"
            sliderClassName="fade-in-slider data-horizontal:w-24"
            valueClassName="w-9 text-muted-foreground"
            value={clip.fadeIn ?? 0}
            min={0}
            max={maxFade}
            step={0.1}
            format={(v) => `${v.toFixed(1)}s`}
            parse={parseSecondsInput}
            onDraft={(v) => setAudio({ fadeIn: v })}
            onCommit={(v) => commitAudio({ fadeIn: v })}
          />
        </Row>
        <Row label="Fade out">
          <ValueSlider
            label="Fade out"
            sliderClassName="fade-out-slider data-horizontal:w-24"
            valueClassName="w-9 text-muted-foreground"
            value={clip.fadeOut ?? 0}
            min={0}
            max={maxFade}
            step={0.1}
            format={(v) => `${v.toFixed(1)}s`}
            parse={parseSecondsInput}
            onDraft={(v) => setAudio({ fadeOut: v })}
            onCommit={(v) => commitAudio({ fadeOut: v })}
          />
        </Row>
        <Row
          label="Duck others"
          info={
            clip.duck !== undefined
              ? `While this clip plays, everything else drops to ${Math.round(clip.duck * 100)}% volume.`
              : "While this clip plays, drop everything else to this volume."
          }
        >
          <ValueSlider
            label="Duck others"
            sliderClassName="duck-slider data-horizontal:w-24"
            valueClassName="w-9 text-muted-foreground"
            value={clip.duck ?? 1}
            min={0}
            max={1}
            step={0.05}
            format={(v) => (v >= 0.999 ? "Off" : formatPercent(v))}
            parse={(raw) => (raw.trim().toLowerCase() === "off" ? 1 : parsePercentInput(raw))}
            onDraft={(v) => setAudio({ duck: v < 0.999 ? v : undefined })}
            onCommit={(v) => commitAudio({ duck: v < 0.999 ? v : undefined })}
          />
        </Row>
        {asset && !assetIsSilent(asset) && (
          <Row
            label="Beats"
            info="Beat markers detected from the music, drawn as dots on the clip. Every drag and trim snaps to them; drag a dot to move it, double-click removes it, ⌥-click the clip adds one."
          >
            <BeatsControl asset={asset} />
          </Row>
        )}
        <Row label="Hidden">
          <Switch
            checked={!!clip.hidden}
            onCheckedChange={(v) => useEditor.getState().updateAudio(clip.id, { hidden: v })}
          />
        </Row>
      </div>
    </>
  );
}

/** The sizes and spacings a title usually wants, offered under each field's
 * chevron; any value in range can still be typed or dragged. */
const TEXT_SIZES = [32, 48, 64, 80, 96, 120, 160, 200, 240];
const LINE_HEIGHTS = [0.9, 1, 1.15, 1.25, 1.5, 1.75, 2];
const LETTER_SPACINGS = [-2, 0, 2, 5, 10, 20];

function TextPanel({ overlay: o }: { overlay: TextOverlay }) {
  const update = useEditor((s) => s.updateOverlay);
  const nav = useAnimNav();
  const sizeCk = useSliderCheckpoint();
  const radiusCk = useSliderCheckpoint();
  const opacityCk = useSliderCheckpoint();
  const spacingCk = useSliderCheckpoint();
  const lineHeightCk = useSliderCheckpoint();
  const strokeCk = useSliderCheckpoint();
  const shadowCk = useSliderCheckpoint();
  const taRef = useRef<HTMLTextAreaElement>(null);
  // The saved-style previews below are set in whatever font each style names,
  // so they re-render when a family finishes registering.
  const [, bumpFonts] = useState(0);
  useEffect(() => onFontsChanged(() => bumpFonts((n) => n + 1)), []);

  // Remember this title's look across clips and projects, so the next new title
  // starts from the same style.
  useEffect(() => {
    writeTextStyle({
      size: o.size,
      font: o.font,
      weight: o.weight,
      italic: o.italic,
      color: o.color,
      stroke: o.stroke,
      letterSpacing: o.letterSpacing,
      lineHeight: o.lineHeight,
      align: o.align,
      shadow: o.shadow,
      plate: o.plate,
      plateColor: o.plateColor,
      plateOpacity: o.plateOpacity,
      plateRadius: o.plateRadius,
    });
  }, [o.size, o.font, o.weight, o.italic, o.color, o.stroke, o.letterSpacing, o.lineHeight, o.align, o.shadow, o.plate, o.plateColor, o.plateOpacity, o.plateRadius]);

  const insertEmoji = (emoji: string) => {
    const ta = taRef.current;
    const s = useEditor.getState();
    s.pushHistory();
    const start = ta?.selectionStart ?? o.text.length;
    const end = ta?.selectionEnd ?? start;
    const next = o.text.slice(0, start) + emoji + o.text.slice(end);
    s.updateOverlayTransient(o.id, { text: next });
    // Advance the caret for the next insert without pulling focus off the
    // picker, so several emoji can be tapped in a row. The selection sticks to
    // the textarea even while it's unfocused.
    requestAnimationFrame(() => ta?.setSelectionRange(start + emoji.length, start + emoji.length));
  };

  return (
    <>
      <PanelTitle>Text</PanelTitle>
      <div className="flex flex-col gap-1 px-3.5 pb-4">
        <div className="relative mb-2">
          <Textarea
            ref={taRef}
            className="min-h-16 select-text pr-9"
            rows={3}
            value={o.text}
            onChange={(e) =>
              useEditor.getState().updateOverlayTransient(o.id, { text: e.target.value })
            }
            onFocus={() => useEditor.getState().pushHistory()}
          />
          <EmojiPicker
            onPick={insertEmoji}
            trigger={
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label="Insert emoji"
                title="Insert emoji"
                className="absolute top-1.5 right-1.5 text-muted-foreground"
              >
                <Smile />
              </Button>
            }
          />
        </div>
        <StylePresetsRow overlay={o} />
        <FontPicker
          value={o.font}
          onChange={(v) => update(o.id, { font: v as TextOverlay["font"] })}
        />
        <div className="mt-1 flex items-center gap-2">
          <SegGroup>
            <SegToggle
              label="Bold"
              active={o.weight === 700}
              onClick={() => update(o.id, { weight: o.weight === 700 ? 400 : 700 })}
            >
              <Bold />
            </SegToggle>
            <SegToggle
              label="Italic"
              active={!!o.italic}
              onClick={() => update(o.id, { italic: o.italic ? undefined : true })}
            >
              <Italic />
            </SegToggle>
          </SegGroup>
          <SegGroup>
            {(
              [
                ["left", AlignLeft],
                ["center", AlignCenter],
                ["right", AlignRight],
              ] as const
            ).map(([a, Icon]) => (
              <SegToggle
                key={a}
                label={`Align ${a}`}
                active={(o.align ?? "center") === a}
                onClick={() => update(o.id, { align: a === "center" ? undefined : a })}
              >
                <Icon />
              </SegToggle>
            ))}
          </SegGroup>
          <NumberField
            label="Text size"
            className="ml-auto w-[74px]"
            icon={<Type />}
            value={o.size}
            min={24}
            max={240}
            step={1}
            presets={TEXT_SIZES}
            format={(v) => String(Math.round(v))}
            parse={parseNumberInput}
            onDraft={(v) => {
              sizeCk.begin();
              useEditor.getState().updateOverlayTransient(o.id, { size: v });
            }}
            onCommit={(v) => {
              sizeCk.begin();
              useEditor.getState().updateOverlayTransient(o.id, { size: v });
              sizeCk.end();
            }}
          />
        </div>
        <div className="mt-1 grid grid-cols-2 gap-2">
          <Field label="Line height">
            <NumberField
              label="Line height"
              icon={<AlignVerticalSpaceAround />}
              value={o.lineHeight ?? 1.25}
              min={0.8}
              max={2}
              step={0.05}
              snap={[1.25]}
              presets={LINE_HEIGHTS}
              format={(v) => v.toFixed(2)}
              parse={parseNumberInput}
              onDraft={(v) => {
                lineHeightCk.begin();
                useEditor.getState().updateOverlayTransient(o.id, {
                  lineHeight: Math.abs(v - 1.25) < 0.025 ? undefined : v,
                });
              }}
              onCommit={(v) => {
                lineHeightCk.begin();
                useEditor.getState().updateOverlayTransient(o.id, {
                  lineHeight: Math.abs(v - 1.25) < 0.025 ? undefined : v,
                });
                lineHeightCk.end();
              }}
            />
          </Field>
          <Field label="Letter spacing">
            <NumberField
              label="Letter spacing"
              icon={<AlignHorizontalSpaceAround />}
              value={(o.letterSpacing ?? 0) * 100}
              min={-5}
              max={30}
              step={1}
              snap={[0]}
              presets={LETTER_SPACINGS}
              format={(v) => `${Math.round(v)}%`}
              parse={(raw) => parseNumberInput(raw.replace(/%$/, ""))}
              onDraft={(v) => {
                spacingCk.begin();
                useEditor.getState().updateOverlayTransient(o.id, {
                  letterSpacing: Math.abs(v) < 0.25 ? undefined : v / 100,
                });
              }}
              onCommit={(v) => {
                spacingCk.begin();
                useEditor.getState().updateOverlayTransient(o.id, {
                  letterSpacing: Math.abs(v) < 0.25 ? undefined : v / 100,
                });
                spacingCk.end();
              }}
            />
          </Field>
        </div>
        <Row label="Color">
          <ColorField
            value={o.color}
            label="Text color"
            onBegin={() => useEditor.getState().pushHistory()}
            onLive={(c) => useEditor.getState().updateOverlayTransient(o.id, { color: c })}
            onCommit={(c) => update(o.id, { color: c })}
          />
        </Row>
        <Section
          title="Outline"
          enabled={!!o.stroke}
          onEnabledChange={(v) =>
            update(o.id, { stroke: v ? { color: "#111114", width: 0.04 } : undefined })
          }
        >
          {o.stroke && (
            <>
              <Row label="Color">
                <ColorField
                  value={o.stroke.color}
                  label="Outline color"
                  onBegin={() => useEditor.getState().pushHistory()}
                  onLive={(c) =>
                    useEditor.getState().updateOverlayTransient(o.id, {
                      stroke: { ...o.stroke!, color: c },
                    })
                  }
                  onCommit={(c) => update(o.id, { stroke: { ...o.stroke!, color: c } })}
                />
              </Row>
              <Row label="Width">
                <ValueSlider
                  label="Outline width"
                  sliderClassName="data-horizontal:w-24"
                  valueClassName="w-9 text-muted-foreground"
                  value={o.stroke.width * 100}
                  min={1}
                  max={15}
                  step={0.5}
                  snap={[4]}
                  format={(v) => String(Math.round(v))}
                  parse={parseNumberInput}
                  onDraft={(v) => {
                    strokeCk.begin();
                    useEditor.getState().updateOverlayTransient(o.id, {
                      stroke: { ...o.stroke!, width: v / 100 },
                    });
                  }}
                  onCommit={(v) => {
                    strokeCk.begin();
                    useEditor.getState().updateOverlayTransient(o.id, {
                      stroke: { ...o.stroke!, width: v / 100 },
                    });
                    strokeCk.end();
                  }}
                />
              </Row>
            </>
          )}
        </Section>
        <Section
          title="Shadow"
          enabled={!!o.shadow}
          onEnabledChange={(v) => update(o.id, { shadow: v })}
        >
          <>
            <Row label="Color">
              <ColorField
                value={(typeof o.shadow === "object" ? o.shadow.color : undefined) ?? "#000000"}
                label="Shadow color"
                onBegin={() => useEditor.getState().pushHistory()}
                onLive={(c) =>
                  useEditor.getState().updateOverlayTransient(o.id, {
                    shadow: { ...(typeof o.shadow === "object" ? o.shadow : {}), color: c },
                  })
                }
                onCommit={(c) =>
                  update(o.id, {
                    shadow: { ...(typeof o.shadow === "object" ? o.shadow : {}), color: c },
                  })
                }
                opacity={{
                  label: "Shadow opacity",
                  value: (typeof o.shadow === "object" ? o.shadow.opacity : undefined) ?? 0.65,
                  onDraft: (v) => {
                    shadowCk.begin();
                    useEditor.getState().updateOverlayTransient(o.id, {
                      shadow: { ...(typeof o.shadow === "object" ? o.shadow : {}), opacity: v },
                    });
                  },
                  onCommit: (v) => {
                    shadowCk.begin();
                    useEditor.getState().updateOverlayTransient(o.id, {
                      shadow: { ...(typeof o.shadow === "object" ? o.shadow : {}), opacity: v },
                    });
                    shadowCk.end();
                  },
                }}
              />
            </Row>
            <Row label="Blur">
              <ValueSlider
                label="Shadow blur"
                sliderClassName="data-horizontal:w-24"
                valueClassName="w-9 text-muted-foreground"
                value={(typeof o.shadow === "object" ? o.shadow.blur : undefined) ?? 14}
                min={0}
                max={60}
                step={1}
                snap={[14]}
                format={(v) => String(Math.round(v))}
                parse={parseNumberInput}
                onDraft={(v) => {
                  shadowCk.begin();
                  useEditor.getState().updateOverlayTransient(o.id, {
                    shadow: { ...(typeof o.shadow === "object" ? o.shadow : {}), blur: v },
                  });
                }}
                onCommit={(v) => {
                  shadowCk.begin();
                  useEditor.getState().updateOverlayTransient(o.id, {
                    shadow: { ...(typeof o.shadow === "object" ? o.shadow : {}), blur: v },
                  });
                  shadowCk.end();
                }}
              />
            </Row>
          </>
        </Section>
        <Section
          title="Backdrop"
          enabled={o.plate}
          onEnabledChange={(v) => update(o.id, { plate: v })}
        >
          <>
            <Row label="Color">
              <ColorField
                value={o.plateColor ?? PLATE_COLOR}
                label="Backdrop color"
                onBegin={() => useEditor.getState().pushHistory()}
                onLive={(c) => useEditor.getState().updateOverlayTransient(o.id, { plateColor: c })}
                onCommit={(c) => update(o.id, { plateColor: c })}
                opacity={{
                  label: "Backdrop opacity",
                  value: o.plateOpacity ?? PLATE_OPACITY,
                  onDraft: (v) => {
                    opacityCk.begin();
                    useEditor.getState().updateOverlayTransient(o.id, { plateOpacity: v });
                  },
                  onCommit: (v) => {
                    opacityCk.begin();
                    useEditor.getState().updateOverlayTransient(o.id, { plateOpacity: v });
                    opacityCk.end();
                  },
                }}
              />
            </Row>
            <Row label="Radius">
              <ValueSlider
                label="Backdrop radius"
                sliderClassName="data-horizontal:w-24"
                valueClassName="w-9 text-muted-foreground"
                value={o.plateRadius ?? PLATE_RADIUS}
                min={0}
                max={1}
                step={0.01}
                snap={[PLATE_RADIUS]}
                format={(v) => String(Math.round(v * 100))}
                parse={parsePercentInput}
                onDraft={(v) => {
                  radiusCk.begin();
                  useEditor.getState().updateOverlayTransient(o.id, { plateRadius: v });
                }}
                onCommit={(v) => {
                  radiusCk.begin();
                  useEditor.getState().updateOverlayTransient(o.id, { plateRadius: v });
                  radiusCk.end();
                }}
              />
            </Row>
          </>
        </Section>
        <OverlayMaskSection overlay={o} />
        <TransformRows overlay={o} />
        <GroupRow overlay={o} />
        <AnimationSection
          overlay={o}
          onOpen={nav.open}
          reveal={nav.view === "returned"}
        />
      </div>
    </>
  );
}

/** Named text-style presets from the shared Library: chips that apply a saved
 * look to the selected title, plus saving the current look under a name. */
function StylePresetsRow({ overlay: o }: { overlay: TextOverlay }) {
  const [presets, setPresets] = useState<StylePreset[] | null>(null);
  const [naming, setNaming] = useState(false);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let live = true;
    listStylePresets()
      .then((p) => live && setPresets(p))
      .catch(() => live && setPresets([]));
    return () => {
      live = false;
    };
  }, []);

  const save = async () => {
    const projectId = useEditor.getState().projectId;
    const trimmed = name.trim();
    if (!projectId || !trimmed || busy) return;
    setBusy(true);
    try {
      const p = await saveStylePreset(projectId, trimmed, o);
      if (p) setPresets((prev) => [p, ...(prev ?? [])]);
      setNaming(false);
      setName("");
    } catch {
      // Signed out or offline shelf — the chips just don't gain one.
    } finally {
      setBusy(false);
    }
  };

  if (presets === null) return null;
  return (
    <div className="mb-1.5">
      <div className="mb-1 flex items-center justify-between">
        <span className="text-[13px] text-muted-foreground">Styles</span>
        {!naming && (
          <button
            type="button"
            className="text-[11.5px] text-muted-foreground transition-colors hover:text-foreground"
            onClick={() => setNaming(true)}
          >
            Save style
          </button>
        )}
      </div>
      {naming && (
        <div className="mb-1.5 flex items-center gap-1.5">
          <input
            autoFocus
            className="h-7 min-w-0 flex-1 rounded-md border border-input bg-transparent px-2 text-[12px] outline-none focus:border-ring"
            placeholder="Style name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void save();
              if (e.key === "Escape") setNaming(false);
            }}
          />
          <Button size="sm" variant="outline" disabled={busy || !name.trim()} onClick={() => void save()}>
            Save
          </Button>
        </div>
      )}
      {presets.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {presets.map((p) => (
            <span key={`${p.residency}:${p.id}`} className="group relative">
              <button
                type="button"
                title={`Apply ${p.name}`}
                className="flex items-center gap-1.5 rounded-md border border-input px-2 py-1 text-[11.5px] transition-colors hover:border-ring"
                onClick={() => useEditor.getState().updateOverlay(o.id, { ...p.style })}
              >
                <span
                  className="leading-none"
                  style={{
                    fontFamily: fontStack(p.style.font),
                    fontWeight: p.style.weight,
                    fontStyle: p.style.italic ? "italic" : undefined,
                    color: p.style.color,
                    textShadow: p.style.shadow ? "0 1px 2px rgba(0,0,0,0.5)" : undefined,
                    background: p.style.plate ? plateFill(p.style) : undefined,
                    borderRadius: p.style.plate ? 3 : undefined,
                    padding: p.style.plate ? "0 3px" : undefined,
                  }}
                >
                  Aa
                </span>
                {p.name}
              </button>
              <button
                type="button"
                title={`Delete ${p.name}`}
                aria-label={`Delete style ${p.name}`}
                className="absolute -top-1.5 -right-1.5 hidden size-4 place-items-center rounded-full bg-black/60 text-[9px] text-white group-hover:grid"
                onClick={() => {
                  void deleteStylePreset(p).catch(() => {});
                  setPresets((prev) => (prev ?? []).filter((x) => x !== p));
                }}
              >
                ✕
              </button>
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

/** Write an animation patch to the element — and its whole group, since a
 * grouped element's animation stamps the group. Neutral (all slots off)
 * stores as absence. */
function writeOverlayAnim(o: Overlay, anim: OverlayAnim, patch: Partial<OverlayAnim>) {
  const next = { ...anim, ...patch };
  if (!next.in) delete next.in;
  if (!next.out) delete next.out;
  if (!next.loop) delete next.loop;
  if (!next.move) delete next.move;
  if (!next.words) delete next.words;
  const value = hasOverlayAnim(next) ? next : undefined;
  const st = useEditor.getState();
  const peers = o.groupId ? st.overlays.filter((x) => x.groupId === o.groupId) : [];
  const targets = peers.length > 1 ? peers : [o];
  st.updateOverlaysTransient(
    targets.map((el) => {
      if (!value?.words || !isTextOverlay(el)) return { id: el.id, patch: { anim: value } };
      // Word times are the element's own — each one's words are said at its
      // own moment — so a grouped write times every member against the cut
      // rather than copying one member's clock onto the rest. Times already
      // measured ride through: the alignment runs when a slot is first filled,
      // never on every frame of a slider drag.
      const carried = el.id === o.id ? value.words.times : el.anim?.words?.times;
      const times = carried ?? wordTimesFor(el, st.subtitles.cues);
      return {
        id: el.id,
        patch: { anim: { ...value, words: { ...value.words, ...(times ? { times } : {}) } } },
      };
    })
  );
}

/** The set slot's Length (In/Out) or Speed (Loop) slider. */
function AnimSlotSlider({
  overlay: o,
  slot,
  label,
}: {
  overlay: Overlay;
  slot: "in" | "out" | "loop";
  label: string;
}) {
  const ck = useSliderCheckpoint();
  const anim = o.anim ?? {};
  const dur = Math.max(0.2, o.end - o.start);
  /** A drag — one undo step for the whole gesture, not one per frame. */
  const drag = (patch: Partial<OverlayAnim>) => {
    ck.begin();
    writeOverlayAnim(o, anim, patch);
  };
  if (slot === "loop") {
    if (!anim.loop) return null;
    return (
      <Row label={label}>
        <ValueSlider
          label={label}
          sliderClassName="data-horizontal:w-24"
          valueClassName="w-9 text-muted-foreground"
          value={anim.loop.speed}
          min={0.25}
          max={4}
          step={0.25}
          format={(v) => `${v.toFixed(2)}×`}
          parse={parseSpeedInput}
          onDraft={(v) => drag({ loop: { ...anim.loop!, speed: v } })}
          onCommit={(v) => {
            drag({ loop: { ...anim.loop!, speed: v } });
            ck.end();
          }}
        />
      </Row>
    );
  }
  const active = anim[slot];
  if (!active) return null;
  return (
    <Row label={label}>
      <ValueSlider
        label={label}
        sliderClassName="data-horizontal:w-24"
        valueClassName="w-9 text-muted-foreground"
        value={active.seconds}
        min={OVERLAY_ANIM_MIN_SECONDS}
        max={Math.min(OVERLAY_ANIM_MAX_SECONDS, dur)}
        step={0.05}
        snap={[OVERLAY_ANIM_DEFAULT_SECONDS]}
        format={(v) => `${v.toFixed(2)}s`}
        parse={parseSecondsInput}
        onDraft={(v) => drag({ [slot]: { ...active, seconds: v } })}
        onCommit={(v) => {
          drag({ [slot]: { ...active, seconds: v } });
          ck.end();
        }}
      />
    </Row>
  );
}

/** The Animation entry every overlay panel carries: the current picks at a
 * glance on a drill-in to the picker, with each set slot's length or speed
 * right under it. */
function AnimationSection({
  overlay: o,
  onOpen,
  reveal,
}: {
  overlay: Overlay;
  onOpen: () => void;
  /** Mounted by the picker's back button: bring the section into view, since
   * the pushed view scrolled away from it. */
  reveal?: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (reveal) ref.current?.scrollIntoView({ block: "nearest" });
  }, [reveal]);
  const anim = o.anim ?? {};
  const slots = (["in", "out", "loop", "words"] as const).filter((s) => anim[s]);
  const clear = (slot: "in" | "out" | "loop" | "words") => {
    stopAnimPreview();
    useEditor.getState().pushHistory();
    writeOverlayAnim(o, anim, { [slot]: undefined });
  };
  return (
    <div ref={ref}>
    <Section
      title="Animation"
      aside={
        <button
          type="button"
          className="anim-open flex h-8 items-center gap-1 rounded-md border border-input px-2.5 text-[11.5px] font-medium text-muted-foreground transition-colors hover:text-foreground"
          onClick={onOpen}
        >
          {slots.length || anim.move ? "Change" : "None"}
          <ChevronRight className="size-3.5 shrink-0" />
        </button>
      }
    >
      {slots.length > 0 && (
        <div className="mt-2 mb-1 grid grid-cols-3 gap-1.5">
          {slots.map((slot, i) => (
            <AnimationCard
              key={slot}
              slot={slot}
              index={i}
              style={anim[slot]!.style}
              isText={isTextOverlay(o)}
              seconds={
                slot === "in" || slot === "out" ? anim[slot]!.seconds : OVERLAY_ANIM_DEFAULT_SECONDS
              }
              speed={anim.loop?.speed ?? 1}
              textColor={isTextOverlay(o) ? o.color : WORD_ACCENT_DEFAULT}
              accentColor={anim.words?.color}
              accentScale={anim.words?.scale}
              accentDim={anim.words?.dim}
              onOpen={onOpen}
              onClear={() => clear(slot)}
            />
          ))}
        </div>
      )}
      <AnimSlotSlider overlay={o} slot="in" label="In duration" />
      <AnimSlotSlider overlay={o} slot="out" label="Out duration" />
      <AnimSlotSlider overlay={o} slot="loop" label="Loop speed" />
      <MoveStrengthRow overlay={o} />
      {anim.words && <WordSettings overlay={o} />}
    </Section>
    </div>
  );
}

/** The move's strength: how hard the hold pushes. The slider sits in two
 * places — the collapsed section, and the animation panel's Move tab — so it
 * is one component. */
function MoveStrengthSlider({ overlay: o, label }: { overlay: Overlay; label: string }) {
  const ck = useSliderCheckpoint();
  const anim = o.anim ?? {};
  const move = anim.move;
  const write = (strength: number) => {
    if (!move) return;
    ck.begin();
    writeOverlayAnim(o, anim, { move: { ...move, strength } });
  };
  return (
    <Row label={label}>
      <ValueSlider
        label={label}
        sliderClassName="data-horizontal:w-24"
        valueClassName="w-9 text-muted-foreground"
        value={move?.strength ?? 1}
        min={MOVE_STRENGTH_MIN}
        max={MOVE_STRENGTH_MAX}
        step={MOVE_STRENGTH_STEP}
        snap={[1]}
        format={(v) => `${Math.round(v * 100)}%`}
        parse={parsePercentInput}
        disabled={!move}
        onDraft={write}
        onCommit={(v) => {
          write(v);
          ck.end();
        }}
      />
    </Row>
  );
}

/** The strength row in the collapsed section, there only once a move is on
 * the element — an empty slider with no move to scale would explain
 * nothing. */
function MoveStrengthRow({ overlay: o }: { overlay: Overlay }) {
  if (!o.anim?.move) return null;
  return <MoveStrengthSlider overlay={o} label="Move strength" />;
}

/** The settings the picked word effect actually has: a swell has a size, a
 * fade has a level, anything that speaks in color has an accent. A knob the
 * effect does not use is left out — a slider with nothing to move explains
 * nothing. With no effect picked the rows sit greyed, so the panel floor
 * keeps its height while the reader scrolls the grid. */
function WordSettings({ overlay: o }: { overlay: Overlay }) {
  const ck = useSliderCheckpoint();
  const anim = o.anim ?? {};
  const words = anim.words;
  const knobs = wordKnobs(wordEffect(words?.style), words);
  // The sliders check-point on the first frame of a drag and release on
  // commit; the color field opens its own on pointer-down, so it writes
  // straight through — borrowing the slider's would leave it open and swallow
  // every checkpoint after it.
  const write = (patch: { scale?: number; dim?: number }) => {
    if (!words) return;
    ck.begin();
    writeOverlayAnim(o, anim, { words: { ...words, ...patch } });
  };
  const setColor = (color: string) => {
    if (!words) return;
    writeOverlayAnim(o, anim, { words: { ...words, color } });
  };
  return (
    <>
      {knobs.size && (
        <Row label="Word size">
          <ValueSlider
            label="Word size"
            sliderClassName="data-horizontal:w-24"
            valueClassName="w-9 text-muted-foreground"
            value={wordSwell(words)}
            min={WORD_SWELL_MIN}
            max={WORD_SWELL_MAX}
            step={0.02}
            snap={[1, WORD_POP_SCALE]}
            format={(v) => `${v.toFixed(2)}×`}
            parse={parseSpeedInput}
            disabled={!words}
            onDraft={(v) => write({ scale: v })}
            onCommit={(v) => {
              write({ scale: v });
              ck.end();
            }}
          />
        </Row>
      )}
      {knobs.dim && (
        <Row label="Faded to">
          <ValueSlider
            label="Faded to"
            sliderClassName="data-horizontal:w-24"
            valueClassName="w-9 text-muted-foreground"
            value={wordDim(words)}
            min={0}
            max={1}
            step={0.01}
            snap={[wordDim({ style: words?.style })]}
            format={(v) => `${Math.round(v * 100)}%`}
            parse={parsePercentInput}
            disabled={!words}
            onDraft={(v) => write({ dim: v })}
            onCommit={(v) => {
              write({ dim: v });
              ck.end();
            }}
          />
        </Row>
      )}
      {knobs.color && (
        <Row label="Word color">
          <ColorField
            value={wordAccent(words, isTextOverlay(o) ? o.color : WORD_ACCENT_DEFAULT)}
            label="Word color"
            onBegin={() => useEditor.getState().pushHistory()}
            onLive={setColor}
            onCommit={setColor}
          />
        </Row>
      )}
    </>
  );
}

/** The slots the picker fills, in tab order. */
type AnimSlot = "in" | "out" | "loop" | "move" | "words";

/** The animation subview an overlay panel pushes into: a tab per slot over
 * the tile grid, the active slot's own control under it. The slots pick from
 * the same grid, one at a time — the tiles are big enough to read the motion,
 * which a stack of grids would not be. */
function AnimationPanel({ overlay: o, onBack }: { overlay: Overlay; onBack: () => void }) {
  const anim = o.anim ?? {};
  // The active slot holds for the session, like every settings view's tab.
  const [picked, setSlot] = usePanelView<AnimSlot>(`anim-slot:${o.id}`, "in");
  // Word emphasis is a title's slot; a shape or a sticker has no words, so
  // selecting one hands the picker back to the entrance.
  const tabs: AnimSlot[] = isTextOverlay(o)
    ? ["in", "out", "loop", "move", "words"]
    : ["in", "out", "loop", "move"];
  const slot = tabs.includes(picked) ? picked : "in";
  const active = slot === "move" || slot === "words" ? undefined : anim[slot];
  const seconds = slot === "in" || slot === "out" ? anim[slot]?.seconds : undefined;
  const activeMove = anim.move;
  const pick = (style: string | null) => {
    if (slot === "words") {
      if (!style && !anim.words) return;
      useEditor.getState().pushHistory();
      // The transcript is the clock: the times land at apply, measured
      // against whatever the cut has been transcribed to say. Nothing to
      // measure against leaves them out, and the words share the element's
      // span instead.
      const patch: Partial<OverlayAnim> = {
        words: style
          ? {
              style: style as WordEffectId,
              ...(anim.words?.color ? { color: anim.words.color } : {}),
              ...(anim.words?.scale !== undefined ? { scale: anim.words.scale } : {}),
              ...(anim.words?.dim !== undefined ? { dim: anim.words.dim } : {}),
            }
          : undefined,
      };
      writeOverlayAnim(o, anim, patch);
      // The pick sweeps itself along the line, the same as any other slot.
      if (style) {
        const el = useEditor.getState().overlays.find((x) => x.id === o.id) ?? o;
        playAnimPreview(el, "words");
      } else stopAnimPreview();
      return;
    }
    if (slot === "move") {
      if (!style && !activeMove) return;
      useEditor.getState().pushHistory();
      // A newly picked move starts at full strength; switching moves keeps
      // whatever strength the last one was set to.
      const patch: Partial<OverlayAnim> = {
        move: style ? { style, strength: activeMove?.strength ?? 1 } : undefined,
      };
      writeOverlayAnim(o, anim, patch);
      // The pick plays itself on the stage, the same as any other slot.
      if (style) playAnimPreview({ ...o, anim: { ...anim, ...patch } }, "move");
      else stopAnimPreview();
      return;
    }
    if (!style) {
      stopAnimPreview();
      useEditor.getState().pushHistory();
      writeOverlayAnim(o, anim, { [slot]: undefined });
      return;
    }
    const patch: Partial<OverlayAnim> =
      slot === "loop"
        ? { loop: { style: style as OverlayLoopStyle, speed: anim.loop?.speed ?? 1 } }
        : {
            [slot]: {
              style: style as OverlayAnimStyle,
              seconds: seconds ?? OVERLAY_ANIM_DEFAULT_SECONDS,
            },
          };
    useEditor.getState().pushHistory();
    writeOverlayAnim(o, anim, patch);
    // The pick plays itself on the stage, for exactly its own length.
    playAnimPreview({ ...o, anim: { ...anim, ...patch } }, slot);
  };
  // A rehearsal belongs to the panel that started it: leaving takes it away.
  useEffect(() => stopAnimPreview, []);

  return (
    // Three bands: the tabs, the grid, the bar. Only the middle one scrolls —
    // it owns the scroller, so the two edges are outside it and stay still
    // even while the grid rubber-bands at its ends.
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="shrink-0 bg-card pb-2">
        <div className="flex h-10 shrink-0 items-center gap-1 px-2.5 text-sm font-semibold tracking-tight">
          <button
            type="button"
            aria-label="Back"
            className="anim-back grid size-6 place-items-center rounded text-muted-foreground transition-colors hover:text-foreground"
            onClick={onBack}
          >
            <ChevronLeft className="size-4" />
          </button>
          Animation
        </div>
        <div className="mx-3.5 flex shrink-0 rounded-lg bg-muted p-0.5 text-[11.5px] font-medium">
          {tabs.map((id) => (
            <button
              key={id}
              type="button"
              className={cn(
                "flex-1 rounded-md px-1.5 py-1 capitalize transition-colors",
                slot === id
                  ? "bg-neutral-900 text-white"
                  : "text-muted-foreground hover:text-foreground",
                // A slot that is already set reads darker, so switching tabs is
                // not the only way to see what an element is doing.
                (id === "move" ? !!activeMove : !!anim[id]) && slot !== id && "text-foreground"
              )}
              onClick={() => setSlot(id)}
            >
              {id}
            </button>
          ))}
        </div>
      </div>
      {/* pt-1 clears the selected tile's ring, which draws outside its box.
          The bounce stops here rather than travelling to the panel behind. */}
      <ScrollArea
        // Keyed on the tab: a new list of tiles starts at its own top.
        key={slot}
        className="min-h-0 flex-1"
        viewportClassName="overscroll-contain"
        contentClassName="flex flex-col gap-1 px-3.5 pt-1 pb-2"
      >
        <AnimationTiles
          slot={slot}
          // A slot carrying its own preset is playing something no tile here
          // names, so the grid shows nothing selected rather than the catalog
          // entry the id happens to hold.
          value={
            active?.preset
              ? undefined
              : slot === "move"
                ? activeMove?.style
                : slot === "words"
                  ? anim.words?.style
                  : active?.style
          }
          custom={!!active?.preset}
          isText={isTextOverlay(o)}
          seconds={seconds ?? OVERLAY_ANIM_DEFAULT_SECONDS}
          speed={anim.loop?.speed ?? 1}
          textColor={isTextOverlay(o) ? o.color : WORD_ACCENT_DEFAULT}
          accentColor={anim.words?.color}
          accentScale={anim.words?.scale}
          accentDim={anim.words?.dim}
          onPick={pick}
        />
      </ScrollArea>
      <AnimationToolbar overlay={o} slot={slot} />
    </div>
  );
}

/** The bar on the panel floor: the one number the active tab has, kept in
 * reach while the reader is still scrolling the grid. Each slot measures
 * something different — a ramp in seconds, a loop's rate, how hard a move
 * pushes — so the bar shows the tab's own control and nothing else. It stays
 * put with the slot unset, greyed rather than gone, because a bar that comes
 * and goes moves the grid under the pointer. */
function AnimationToolbar({ overlay: o, slot }: { overlay: Overlay; slot: AnimSlot }) {
  const ck = useSliderCheckpoint();
  const anim = o.anim ?? {};
  const dur = Math.max(0.2, o.end - o.start);
  const edge = slot === "in" || slot === "out" ? anim[slot] : undefined;

  const bar = (children: React.ReactNode) => (
    <div className="shrink-0 border-t border-border bg-card px-3.5 py-0.5">{children}</div>
  );

  if (slot === "move") return bar(<MoveStrengthSlider overlay={o} label="Strength" />);

  if (slot === "words") return bar(<WordSettings overlay={o} />);

  if (slot === "loop") {
    const write = (speed: number) => {
      if (!anim.loop) return;
      ck.begin();
      writeOverlayAnim(o, anim, { loop: { ...anim.loop, speed } });
    };
    return bar(
      <Row label="Speed">
        <ValueSlider
          label="Speed"
          sliderClassName="data-horizontal:w-24"
          valueClassName="w-9 text-muted-foreground"
          value={anim.loop?.speed ?? 1}
          min={0.25}
          max={4}
          step={0.25}
          snap={[1]}
          format={(v) => `${v.toFixed(2)}×`}
          parse={parseSpeedInput}
          disabled={!anim.loop}
          onDraft={write}
          onCommit={(v) => {
            write(v);
            ck.end();
          }}
        />
      </Row>
    );
  }

  const write = (secs: number) => {
    if (!edge) return;
    ck.begin();
    writeOverlayAnim(o, anim, { [slot]: { ...edge, seconds: secs } });
  };
  return bar(
    <Row label="Duration">
      <ValueSlider
        label="Duration"
        sliderClassName="data-horizontal:w-24"
        valueClassName="w-9 text-muted-foreground"
        value={edge?.seconds ?? OVERLAY_ANIM_DEFAULT_SECONDS}
        min={OVERLAY_ANIM_MIN_SECONDS}
        max={Math.min(OVERLAY_ANIM_MAX_SECONDS, dur)}
        step={0.05}
        snap={[OVERLAY_ANIM_DEFAULT_SECONDS]}
        format={(v) => `${v.toFixed(2)}s`}
        parse={parseSecondsInput}
        disabled={!edge}
        onDraft={write}
        onCommit={(v) => {
          write(v);
          ck.end();
        }}
      />
    </Row>
  );
}

/** Group / Ungroup, shown when the selection can form one or the element is
 * in one. Grouping is shallow by design: select-one-selects-all, and gestures
 * apply member-relative deltas. */
function GroupRow({ overlay: o }: { overlay: Overlay }) {
  const selectedOverlays = useEditor(
    (s) => s.multiSelection.filter((x) => x?.kind === "overlay").length
  );
  if (o.groupId) {
    return (
      <Row label="Group">
        <Button
          size="sm"
          variant="outline"
          onClick={() => useEditor.getState().ungroupOverlays(o.groupId!)}
        >
          Ungroup
        </Button>
      </Row>
    );
  }
  if (selectedOverlays < 2) return null;
  return (
    <Row label="Group">
      <Button size="sm" variant="outline" onClick={() => useEditor.getState().groupSelectedOverlays()}>
        Group {selectedOverlays} elements
      </Button>
    </Row>
  );
}

/** Rotation and opacity, shared by every overlay kind. Neutral values store
 * as absence so untouched elements carry nothing. */
/** The element twin of the clip panels' Hidden row: parked on the timeline,
 * out of the played and exported picture. It closes the Transform section
 * (the effect panel, which has no Transform, mounts it alone), so the
 * timeline chip always has an inspector fallback. */
function HiddenRow({ overlay: o }: { overlay: Overlay }) {
  const update = useEditor((s) => s.updateOverlay);
  return (
    <Row label="Hidden">
      <Switch
        checked={!!o.hidden}
        onCheckedChange={(v) => update(o.id, { hidden: v || undefined })}
      />
    </Row>
  );
}

/** X and Y as percentages of the frame, the pair of scrubs both the element
 * and the clip transform sections show. The range differs — an element stays
 * inside the frame, a keyed clip pans past it. */
function PositionRow({
  pose,
  min,
  max,
  ck,
  onSet,
}: {
  pose: { x: number; y: number };
  min: number;
  max: number;
  ck: { begin: () => void; end: () => void };
  onSet: (axis: "x" | "y", pct: number) => void;
}) {
  return (
    <Row label="Position">
      {(["x", "y"] as const).map((axis) => (
        <span key={axis} className="flex items-center gap-1">
          <span className="text-[11px] text-muted-foreground/70 uppercase">{axis}</span>
          <ScrubValue
            label={`${axis.toUpperCase()} position`}
            className="w-9 text-muted-foreground"
            value={pose[axis] * 100}
            min={min}
            max={max}
            step={0.5}
            keyStep={1}
            snap={[50]}
            format={(v) => String(Math.round(v))}
            parse={parseNumberInput}
            onScrub={(v) => {
              ck.begin();
              onSet(axis, v);
            }}
            onCommit={(v) => {
              ck.begin();
              onSet(axis, v);
              ck.end();
            }}
          />
        </span>
      ))}
    </Row>
  );
}

function TransformRows({ overlay: o }: { overlay: Overlay }) {
  const rotationCk = useSliderCheckpoint();
  const opacityCk = useSliderCheckpoint();
  const scaleCk = useSliderCheckpoint();
  const posCk = useSliderCheckpoint();
  const now = usePreviewTime();
  // With keys in play these rows edit the pose at the playhead rather than the
  // element's resting fields — which is what makes them a track.
  const keyed = hasOverlayKeys(o);
  const tLocal = localTimeOf(o, now);
  const pose = poseAt(o, tLocal);
  const setKey = (patch: Partial<Omit<OverlayKey, "t">>) =>
    useEditor.getState().setOverlayKey(o.id, tLocal, patch, { transient: true });
  const setRotation = (v: number) => {
    const deg = Math.round(v);
    if (keyed) return setKey({ rotation: deg });
    useEditor.getState().updateOverlayTransient(o.id, { rotation: deg === 0 ? undefined : deg });
  };
  const setOpacity = (v: number) => {
    const a = Math.max(0, Math.min(1, v));
    if (keyed) return setKey({ opacity: a });
    useEditor.getState().updateOverlayTransient(o.id, { opacity: a >= 0.995 ? undefined : a });
  };
  // Position reads as a percentage of the frame, which is what the document
  // stores — an element sits in the same spot at any aspect, and the number
  // means the same thing on a square as on a widescreen.
  const setPos = (axis: "x" | "y", pct: number) => {
    const v = clampOverlayPos(pct / 100);
    if (keyed) return setKey({ [axis]: v });
    useEditor.getState().updateOverlayTransient(o.id, { [axis]: v });
  };
  return (
    <Section title="Transform">
      <KeyframeControls overlay={o} />
      <PositionRow pose={pose} min={2} max={98} ck={posCk} onSet={setPos} />
      {keyed && (
        <Row label="Scale">
          <ValueSlider
            label="Scale"
            sliderClassName="data-horizontal:w-24"
            valueClassName="w-9 text-muted-foreground"
            value={pose.scale}
            min={0.1}
            max={4}
            step={0.01}
            snap={[1]}
            keyStep={0.05}
            format={(v) => `${Math.round(v * 100)}%`}
            parse={parsePercentInput}
            onDraft={(v) => {
              scaleCk.begin();
              setKey({ scale: v });
            }}
            onCommit={(v) => {
              scaleCk.begin();
              setKey({ scale: v });
              scaleCk.end();
            }}
          />
        </Row>
      )}
      <Row label="Rotation">
        <ValueSlider
          label="Rotation"
          sliderClassName="data-horizontal:w-24"
          valueClassName="w-9 text-muted-foreground"
          value={keyed ? pose.rotation : (o.rotation ?? 0)}
          min={-180}
          max={180}
          step={1}
          snap={[-90, 0, 90]}
          format={(v) => `${Math.round(v)}°`}
          parse={parseNumberInput}
          onDraft={(v) => {
            rotationCk.begin();
            setRotation(v);
          }}
          onCommit={(v) => {
            rotationCk.begin();
            setRotation(v);
            rotationCk.end();
          }}
        />
      </Row>
      <Row label="Opacity">
        <ValueSlider
          label="Opacity"
          sliderClassName="data-horizontal:w-24"
          valueClassName="w-9 text-muted-foreground"
          value={keyed ? pose.opacity : (o.opacity ?? 1)}
          min={0}
          max={1}
          step={0.01}
          format={(v) => String(Math.round(v * 100))}
          parse={parsePercentInput}
          onDraft={(v) => {
            opacityCk.begin();
            setOpacity(v);
          }}
          onCommit={(v) => {
            opacityCk.begin();
            setOpacity(v);
            opacityCk.end();
          }}
        />
      </Row>
      <HiddenRow overlay={o} />
    </Section>
  );
}

/** Seconds into the element at the playhead, clamped to its own window. */
function localTimeOf(o: { start: number; end: number }, now: number): number {
  return Math.max(0, Math.min(now - o.start, Math.max(0.1, o.end - o.start)));
}

/**
 * The keyframe track: the first row of Transform, because a key holds exactly
 * what the rows under it show. The diamond stores that pose where the playhead
 * stands, the arrows walk the keys already set, and the bin drops the one under
 * the playhead. A key has no form of its own — it is edited by moving the
 * element or pulling those same rows.
 */
function KeyframeControls({ overlay: o }: { overlay: Overlay }) {
  const now = usePreviewTime();
  const seek = useEditor((s) => s.seek);
  const st = () => useEditor.getState();
  return (
    <KeyRow
      element={o}
      now={now}
      keys={o.kf ?? []}
      onAdd={(tLocal) => st().setOverlayKey(o.id, tLocal)}
      onRemove={(tLocal) => st().removeOverlayKey(o.id, tLocal)}
      onSeek={seek}
    />
  );
}

/** The key track row itself — diamond, walkers, count, bin — over whichever
 * key list it is handed. The pose track and the mask track both mount it;
 * the mask track's diamond wears the timeline's amber so the two tracks
 * read apart everywhere. */
function KeyRow({
  element,
  now,
  keys,
  track = "pose",
  onAdd,
  onRemove,
  onSeek,
}: {
  element: { start: number; end: number };
  now: number;
  keys: { t: number }[];
  track?: "pose" | "mask";
  onAdd: (tLocal: number) => void;
  onRemove: (tLocal: number) => void;
  onSeek: (t: number) => void;
}) {
  const inWindow = now >= element.start - 1e-6 && now <= element.end + 1e-6;
  const tLocal = Math.max(
    0,
    Math.min(now - element.start, Math.max(0.1, element.end - element.start))
  );
  const here = keyIndexAt(keys, tLocal);
  const prev = [...keys].sort((a, b) => a.t - b.t).reverse().find((k) => k.t < tLocal - KEY_EPSILON);
  const next = [...keys].sort((a, b) => a.t - b.t).find((k) => k.t > tLocal + KEY_EPSILON);
  return (
    <Row label="Keyframes">
      <Button
        size="sm"
        variant="ghost"
        className="size-7 p-0"
        disabled={!inWindow}
        title={here >= 0 ? "Update the key here" : "Add a key at the playhead"}
        aria-label={here >= 0 ? "Update the key here" : "Add a key at the playhead"}
        onClick={() => onAdd(tLocal)}
      >
        <Diamond
          className={cn(
            "size-3.5",
            track === "mask" && "text-[#ff9f0a]",
            here >= 0 && "fill-current"
          )}
        />
      </Button>
      <Button
        size="sm"
        variant="ghost"
        className="size-7 p-0"
        disabled={!prev}
        title="Previous key"
        aria-label="Previous key"
        onClick={() => prev && onSeek(element.start + prev.t)}
      >
        <ChevronLeft className="size-3.5" />
      </Button>
      <Button
        size="sm"
        variant="ghost"
        className="size-7 p-0"
        disabled={!next}
        title="Next key"
        aria-label="Next key"
        onClick={() => next && onSeek(element.start + next.t)}
      >
        <ChevronRight className="size-3.5" />
      </Button>
      {keys.length > 0 && <Value className="text-muted-foreground">{keys.length}</Value>}
      <Button
        size="sm"
        variant="ghost"
        // Icons centre in a 28px box; the value columns below run to the panel
        // edge. The pull-right lands this glyph on the same edge as their text.
        className="-mr-1.5 size-7 p-0 text-muted-foreground"
        disabled={here < 0}
        title="Remove the key here"
        aria-label="Remove the key here"
        onClick={() => onRemove(tLocal)}
      >
        <Trash2 className="size-3.5" />
      </Button>
    </Row>
  );
}

const MASK_SHAPES: { id: MaskKind; label: string }[] = [
  { id: "rect", label: "Rectangle" },
  { id: "square", label: "Square" },
  { id: "circle", label: "Circle" },
  { id: "linear", label: "Linear" },
  { id: "mirror", label: "Mirror" },
  { id: "subject", label: "Subject" },
];

/** How a panel's mask section reads and writes its owner's mask — the same
 * section serves overlay elements and video clips through this. */
interface MaskTarget {
  /** Timeline window for the keyframe row and playhead-local time. */
  element: { start: number; end: number };
  mask?: Mask;
  /** Replace the mask outright (or remove it), as one undo step. */
  set: (mask: Mask | undefined) => void;
  /** Live-drag mask update, no undo entry. */
  setTransient: (mask: Mask) => void;
  setKey: (
    tLocal: number,
    patch?: Partial<Omit<MaskKey, "t">>,
    opts?: { transient?: boolean }
  ) => void;
  removeKey: (tLocal: number) => void;
}

/**
 * A video clip's pose track: the keyframe row plus, once keys exist, the
 * position/scale/rotation/opacity rows editing the key at the playhead — the
 * element Transform contract over the clip's anchor. A clip with no keys
 * rests in its region, so the rows appear with the first key.
 */
function ClipTransformSection({ clip }: { clip: VideoClip }) {
  const clips = useEditor((s) => s.clips);
  const assets = useEditor((s) => s.assets);
  const now = usePreviewTime();
  const seek = useEditor((s) => s.seek);
  const posCk = useSliderCheckpoint();
  const scaleCk = useSliderCheckpoint();
  const rotationCk = useSliderCheckpoint();
  const opacityCk = useSliderCheckpoint();
  const st = () => useEditor.getState();
  const win = clipWindow(clips, assets, clip.id);
  if (!win) return null;
  const el = { start: win.start, end: win.start + win.len };
  const tLocal = localTimeOf(el, now);
  const keyed = clipKeyed(clip);
  const pose = clipPoseAt(clip, tLocal);
  const setKey = (patch: Partial<Omit<OverlayKey, "t">>) =>
    st().setClipKey(clip.id, tLocal, patch, { transient: true });
  return (
    <Section title="Transform">
      <KeyRow
        element={el}
        now={now}
        keys={clip.kf ?? []}
        onAdd={(t) => st().setClipKey(clip.id, t)}
        onRemove={(t) => st().removeClipKey(clip.id, t)}
        onSeek={seek}
      />
      {keyed && (
        <>
          <PositionRow
            pose={pose}
            min={-50}
            max={150}
            ck={posCk}
            onSet={(axis, pct) => setKey({ [axis]: pct / 100 })}
          />
          <Row label="Scale">
            <ValueSlider
              label="Scale"
              sliderClassName="data-horizontal:w-24"
              valueClassName="w-9 text-muted-foreground"
              value={pose.scale}
              min={0.1}
              max={4}
              step={0.01}
              snap={[1]}
              keyStep={0.05}
              format={(v) => `${Math.round(v * 100)}%`}
              parse={parsePercentInput}
              onDraft={(v) => {
                scaleCk.begin();
                setKey({ scale: v });
              }}
              onCommit={(v) => {
                scaleCk.begin();
                setKey({ scale: v });
                scaleCk.end();
              }}
            />
          </Row>
          <Row label="Rotation">
            <ValueSlider
              label="Rotation"
              sliderClassName="data-horizontal:w-24"
              valueClassName="w-9 text-muted-foreground"
              value={pose.rotation}
              min={-180}
              max={180}
              step={1}
              snap={[-90, 0, 90]}
              format={(v) => `${Math.round(v)}°`}
              parse={parseNumberInput}
              onDraft={(v) => {
                rotationCk.begin();
                setKey({ rotation: Math.round(v) });
              }}
              onCommit={(v) => {
                rotationCk.begin();
                setKey({ rotation: Math.round(v) });
                rotationCk.end();
              }}
            />
          </Row>
          <Row label="Opacity">
            <ValueSlider
              label="Opacity"
              sliderClassName="data-horizontal:w-24"
              valueClassName="w-9 text-muted-foreground"
              value={pose.opacity}
              min={0}
              max={1}
              step={0.01}
              format={(v) => String(Math.round(v * 100))}
              parse={parsePercentInput}
              onDraft={(v) => {
                opacityCk.begin();
                setKey({ opacity: v });
              }}
              onCommit={(v) => {
                opacityCk.begin();
                setKey({ opacity: v });
                opacityCk.end();
              }}
            />
          </Row>
        </>
      )}
    </Section>
  );
}

/** The overlay inspector's mask target, over the overlay store actions. */
function OverlayMaskSection({ overlay: o }: { overlay: Overlay }) {
  const st = () => useEditor.getState();
  return (
    <MaskSection
      target={{
        element: o,
        mask: o.mask,
        set: (mask) => st().updateOverlay(o.id, { mask }),
        setTransient: (mask) => st().updateOverlayTransient(o.id, { mask }),
        setKey: (t, patch, opts) => st().setOverlayMaskKey(o.id, t, patch, opts),
        removeKey: (t) => st().removeOverlayMaskKey(o.id, t),
      }}
    />
  );
}

/** The clip inspector's mask target, over the clip store actions. The clip's
 * timeline window comes through `clipWindow` (track-0 starts derive from the
 * span layout). */
/** Rounded corners and a border stroke on the clip's box. The section's
 * switch turns the style on with visible defaults; off returns the clip to a
 * plain box. */
function ClipBorderSection({ clip }: { clip: VideoClip }) {
  const widthCk = useSliderCheckpoint();
  const radiusCk = useSliderCheckpoint();
  const bs = clip.boxStyle;
  const st = () => useEditor.getState();
  const write = (patch: Partial<BoxStyle>) =>
    st().updateClipTransient(clip.id, { boxStyle: { ...st().clips.find((c) => c.id === clip.id)?.boxStyle, ...patch } });
  return (
    <Section
      title="Border"
      info="Round the clip's corners and stroke a border along its box edge. Sizes are design pixels, matched between preview and export."
      enabled={!!bs}
      onEnabledChange={(v) =>
        st().updateClip(clip.id, {
          boxStyle: v ? { radius: 16, borderWidth: 6, borderColor: "#FFFFFF" } : undefined,
        })
      }
    >
      {bs && (
        <>
          <Row label="Width">
            <ScrubValue
              label="Border width"
              className="w-9 text-muted-foreground"
              value={bs.borderWidth ?? 0}
              min={0}
              max={60}
              step={1}
              format={(v) => String(Math.round(v))}
              parse={parseNumberInput}
              onScrub={(v) => {
                widthCk.begin();
                write({ borderWidth: v });
              }}
              onCommit={(v) => {
                widthCk.begin();
                write({ borderWidth: v });
                widthCk.end();
              }}
            />
          </Row>
          <Row label="Radius">
            <ScrubValue
              label="Corner radius"
              className="w-9 text-muted-foreground"
              value={bs.radius ?? 0}
              min={0}
              max={200}
              step={1}
              format={(v) => String(Math.round(v))}
              parse={parseNumberInput}
              onScrub={(v) => {
                radiusCk.begin();
                write({ radius: v });
              }}
              onCommit={(v) => {
                radiusCk.begin();
                write({ radius: v });
                radiusCk.end();
              }}
            />
          </Row>
          <Row label="Color">
            <ColorField
              value={bs.borderColor ?? "#FFFFFF"}
              label="Border color"
              onBegin={() => st().pushHistory()}
              onLive={(c) => write({ borderColor: c })}
              onCommit={(c) => st().updateClip(clip.id, { boxStyle: { ...bs, borderColor: c } })}
            />
          </Row>
        </>
      )}
    </Section>
  );
}

/** The clip's drop shadow: cast by whatever shape the clip really shows — the
 * box, its rounded corners, and its mask together. */
function ClipShadowSection({ clip }: { clip: VideoClip }) {
  const blurCk = useSliderCheckpoint();
  const offsetCk = useSliderCheckpoint();
  const opacityCk = useSliderCheckpoint();
  const st = () => useEditor.getState();
  const sh = clip.boxStyle?.shadow;
  const write = (patch: Partial<ClipShadow>) => {
    const cur = st().clips.find((c) => c.id === clip.id)?.boxStyle;
    st().updateClipTransient(clip.id, {
      boxStyle: { ...cur, shadow: { blur: cur?.shadow?.blur ?? 24, ...cur?.shadow, ...patch } },
    });
  };
  return (
    <Section
      title="Shadow"
      info="Cast a drop shadow from the clip's shape — its box, corners, and mask together, so a circle-masked clip throws a circular shadow. Sizes are design pixels, matched between preview and export."
      enabled={!!sh}
      onEnabledChange={(v) =>
        st().updateClip(clip.id, {
          boxStyle: v
            ? { ...clip.boxStyle, shadow: { blur: 24, y: 12 } }
            : clip.boxStyle?.radius || clip.boxStyle?.borderWidth
              ? { ...clip.boxStyle, shadow: undefined }
              : undefined,
        })
      }
    >
      {sh && (
        <>
          <Row label="Blur">
            <ScrubValue
              label="Shadow blur"
              className="w-9 text-muted-foreground"
              value={sh.blur}
              min={0}
              max={120}
              step={1}
              format={(v) => String(Math.round(v))}
              parse={parseNumberInput}
              onScrub={(v) => {
                blurCk.begin();
                write({ blur: v });
              }}
              onCommit={(v) => {
                blurCk.begin();
                write({ blur: v });
                blurCk.end();
              }}
            />
          </Row>
          <Row label="Offset">
            {(["x", "y"] as const).map((axis) => (
              <span key={axis} className="flex items-center gap-1">
                <span className="text-[11px] text-muted-foreground/70 uppercase">{axis}</span>
                <ScrubValue
                  label={`Shadow ${axis.toUpperCase()} offset`}
                  className="w-9 text-muted-foreground"
                  value={sh[axis] ?? 0}
                  min={-120}
                  max={120}
                  step={1}
                  format={(v) => String(Math.round(v))}
                  parse={parseNumberInput}
                  onScrub={(v) => {
                    offsetCk.begin();
                    write({ [axis]: Math.round(v) || undefined });
                  }}
                  onCommit={(v) => {
                    offsetCk.begin();
                    write({ [axis]: Math.round(v) || undefined });
                    offsetCk.end();
                  }}
                />
              </span>
            ))}
          </Row>
          <Row label="Opacity">
            <ValueSlider
              label="Shadow opacity"
              sliderClassName="data-horizontal:w-24"
              valueClassName="w-9 text-muted-foreground"
              value={sh.opacity ?? 0.35}
              min={0}
              max={1}
              step={0.01}
              format={formatPercent}
              parse={parsePercentInput}
              onDraft={(v) => {
                opacityCk.begin();
                write({ opacity: v });
              }}
              onCommit={(v) => {
                opacityCk.begin();
                write({ opacity: v });
                opacityCk.end();
              }}
            />
          </Row>
          <Row label="Color">
            <ColorField
              value={sh.color ?? "#000000"}
              label="Shadow color"
              onBegin={() => st().pushHistory()}
              onLive={(c) => write({ color: c })}
              onCommit={(c) => write({ color: c })}
            />
          </Row>
        </>
      )}
    </Section>
  );
}

function ClipMaskSection({ clip }: { clip: VideoClip }) {
  const clips = useEditor((s) => s.clips);
  const assets = useEditor((s) => s.assets);
  const st = () => useEditor.getState();
  const win = clipWindow(clips, assets, clip.id);
  if (!win) return null;
  return (
    <MaskSection
      target={{
        element: { start: win.start, end: win.start + win.len },
        mask: clip.mask,
        set: (mask) => st().updateClip(clip.id, { mask }),
        setTransient: (mask) => st().updateClipTransient(clip.id, { mask }),
        setKey: (t, patch, opts) => st().setClipMaskKey(clip.id, t, patch, opts),
        removeKey: (t) => st().removeClipMaskKey(clip.id, t),
      }}
    />
  );
}

/**
 * The mask itself: shape picker, its own keyframe track, and the geometry
 * rows. With mask keys in play the rows edit the key at the playhead, the
 * same contract as Transform; otherwise they edit the mask's resting fields.
 */
function MaskSection({ target }: { target: MaskTarget }) {
  const now = usePreviewTime();
  const seek = useEditor((s) => s.seek);
  const posCk = useSliderCheckpoint();
  const sizeCk = useSliderCheckpoint();
  const rotationCk = useSliderCheckpoint();
  const featherCk = useSliderCheckpoint();
  const radiusCk = useSliderCheckpoint();
  const m = target.mask;
  const tLocal = localTimeOf(target.element, now);
  const geom = m ? maskFrameAt(m, tLocal) : null;
  const writeGeom = (patch: Partial<Omit<MaskKey, "t">>) => {
    if (!m) return;
    if (hasMaskKeys(m)) return target.setKey(tLocal, patch, { transient: true });
    target.setTransient({ ...m, ...patch });
  };
  // Which size axes the shape has: a square has one side, a mirror band one
  // height, linear none.
  const sizeAxes: ("w" | "h")[] =
    m?.kind === "rect" || m?.kind === "circle"
      ? ["w", "h"]
      : m?.kind === "square"
        ? ["w"]
        : m?.kind === "mirror"
          ? ["h"]
          : [];
  const subject = m?.kind === "subject";
  return (
    <Section
      title="Mask"
      info="Trim the picture to a shape, or to the person in the shot (Subject). Feather softens the edge, and invert keeps what the shape leaves out — an inverted Subject mask sits the picture behind the speaker."
      enabled={!!m}
      onEnabledChange={(v) => target.set(v ? { kind: "rect" } : undefined)}
    >
      {m && geom && (
        <>
          <Row label="Shape">
            <Select
              value={m.kind}
              onValueChange={(kind) => {
                // A fresh circle starts perfectly round: w and h are frame
                // fractions, so equal pixels means unequal fractions. ⇧-drag
                // on the stage keeps it round through resizes.
                const patch =
                  kind === "circle" && !hasMaskKeys(m)
                    ? (() => {
                        const fr = frameOf(useEditor.getState().aspect);
                        const w = m.w ?? 0.5;
                        return { w, h: (w * fr.w) / fr.h };
                      })()
                    : {};
                target.set({ ...m, ...patch, kind: kind as MaskKind });
              }}
            >
              <SelectTrigger className="h-8 w-36 text-[12px]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {MASK_SHAPES.map((s) => (
                  <SelectItem key={s.id} value={s.id} className="text-[12px]">
                    {s.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Row>
          {!subject && (
            <KeyRow
              element={target.element}
              now={now}
              keys={m.kf ?? []}
              track="mask"
              onAdd={(t) => target.setKey(t)}
              onRemove={(t) => target.removeKey(t)}
              onSeek={seek}
            />
          )}
          {!subject && (
            <Row label="Position">
              {(["x", "y"] as const).map((axis) => (
                <span key={axis} className="flex items-center gap-1">
                  <span className="text-[11px] text-muted-foreground/70 uppercase">{axis}</span>
                  <ScrubValue
                    label={`Mask ${axis.toUpperCase()} offset`}
                    className="w-9 text-muted-foreground"
                    value={geom[axis] * 100}
                    min={-100}
                    max={100}
                    step={0.5}
                    keyStep={1}
                    snap={[0]}
                    format={(v) => String(Math.round(v))}
                    parse={parseNumberInput}
                    onScrub={(v) => {
                      posCk.begin();
                      writeGeom({ [axis]: v / 100 });
                    }}
                    onCommit={(v) => {
                      posCk.begin();
                      writeGeom({ [axis]: v / 100 });
                      posCk.end();
                    }}
                  />
                </span>
              ))}
            </Row>
          )}
          {sizeAxes.length > 0 && (
            <Row label="Size">
              {sizeAxes.map((axis) => (
                <span key={axis} className="flex items-center gap-1">
                  <span className="text-[11px] text-muted-foreground/70 uppercase">{axis}</span>
                  <ScrubValue
                    label={`Mask ${axis === "w" ? "width" : "height"}`}
                    className="w-9 text-muted-foreground"
                    value={geom[axis] * 100}
                    min={1}
                    max={200}
                    step={1}
                    snap={[100]}
                    format={(v) => String(Math.round(v))}
                    parse={parseNumberInput}
                    onScrub={(v) => {
                      sizeCk.begin();
                      writeGeom({ [axis]: v / 100 });
                    }}
                    onCommit={(v) => {
                      sizeCk.begin();
                      writeGeom({ [axis]: v / 100 });
                      sizeCk.end();
                    }}
                  />
                </span>
              ))}
            </Row>
          )}
          {!subject && (
            <Row label="Rotation">
              <ValueSlider
                label="Mask rotation"
                sliderClassName="data-horizontal:w-24"
                valueClassName="w-9 text-muted-foreground"
                value={geom.rotation}
                min={-180}
                max={180}
                step={1}
                snap={[-90, 0, 90]}
                format={(v) => `${Math.round(v)}°`}
                parse={parseNumberInput}
                onDraft={(v) => {
                  rotationCk.begin();
                  writeGeom({ rotation: Math.round(v) });
                }}
                onCommit={(v) => {
                  rotationCk.begin();
                  writeGeom({ rotation: Math.round(v) });
                  rotationCk.end();
                }}
              />
            </Row>
          )}
          <Row label="Feather">
            <ValueSlider
              label="Feather"
              sliderClassName="data-horizontal:w-24"
              valueClassName="w-9 text-muted-foreground"
              value={geom.feather}
              min={0}
              max={120}
              step={1}
              format={(v) => String(Math.round(v))}
              parse={parseNumberInput}
              onDraft={(v) => {
                featherCk.begin();
                writeGeom({ feather: Math.round(v) });
              }}
              onCommit={(v) => {
                featherCk.begin();
                writeGeom({ feather: Math.round(v) });
                featherCk.end();
              }}
            />
          </Row>
          {(m.kind === "rect" || m.kind === "square") && (
            <Row label="Radius">
              <ValueSlider
                label="Mask corner radius"
                sliderClassName="data-horizontal:w-24"
                valueClassName="w-9 text-muted-foreground"
                value={m.radius ?? 0}
                min={0}
                max={200}
                step={1}
                format={(v) => String(Math.round(v))}
                parse={parseNumberInput}
                onDraft={(v) => {
                  radiusCk.begin();
                  const radius = Math.round(v);
                  target.setTransient({ ...m, radius: radius === 0 ? undefined : radius });
                }}
                onCommit={(v) => {
                  radiusCk.begin();
                  const radius = Math.round(v);
                  target.setTransient({ ...m, radius: radius === 0 ? undefined : radius });
                  radiusCk.end();
                }}
              />
            </Row>
          )}
          <Row label="Invert">
            <Switch
              checked={!!m.invert}
              onCheckedChange={(v) => target.set({ ...m, invert: v || undefined })}
              aria-label="Invert mask"
            />
          </Row>
        </>
      )}
    </Section>
  );
}

function ShapePanel({ overlay: o }: { overlay: ShapeOverlay }) {
  const update = useEditor((s) => s.updateOverlay);
  const fillCk = useSliderCheckpoint();
  const radiusCk = useSliderCheckpoint();
  const strokeCk = useSliderCheckpoint();
  const nav = useAnimNav();
  const boxShape = !lineLikeShape(o.shape);
  return (
    <>
      <PanelTitle>{SHAPE_LABELS[o.shape]}</PanelTitle>
      <div className="flex flex-col gap-1 px-3.5 pb-4">
        <Row label={boxShape ? "Fill" : "Color"}>
          <ColorField
            value={o.fill}
            label={boxShape ? "Fill color" : "Shape color"}
            onBegin={() => useEditor.getState().pushHistory()}
            onLive={(c) => useEditor.getState().updateOverlayTransient(o.id, { fill: c })}
            onCommit={(c) => update(o.id, { fill: c })}
            opacity={
              boxShape
                ? {
                    label: "Fill opacity",
                    value: o.fillOpacity ?? 1,
                    onDraft: (v) => {
                      fillCk.begin();
                      useEditor.getState().updateOverlayTransient(o.id, {
                        fillOpacity: v >= 0.995 ? undefined : v,
                      });
                    },
                    onCommit: (v) => {
                      fillCk.begin();
                      useEditor.getState().updateOverlayTransient(o.id, {
                        fillOpacity: v >= 0.995 ? undefined : v,
                      });
                      fillCk.end();
                    },
                  }
                : undefined
            }
          />
        </Row>
        {o.shape === "rect" && (
          <Row label="Corner radius">
            <ValueSlider
              label="Corner radius"
              sliderClassName="data-horizontal:w-24"
              valueClassName="w-9 text-muted-foreground"
              value={o.radius ?? 0}
              min={0}
              max={120}
              step={1}
              format={(v) => String(Math.round(v))}
              parse={parseNumberInput}
              onDraft={(v) => {
                radiusCk.begin();
                const radius = Math.round(v);
                useEditor.getState().updateOverlayTransient(o.id, {
                  radius: radius === 0 ? undefined : radius,
                });
              }}
              onCommit={(v) => {
                radiusCk.begin();
                const radius = Math.round(v);
                useEditor.getState().updateOverlayTransient(o.id, {
                  radius: radius === 0 ? undefined : radius,
                });
                radiusCk.end();
              }}
            />
          </Row>
        )}
        {boxShape && (
          <Section
            title="Outline"
            enabled={!!o.stroke}
            onEnabledChange={(v) =>
              update(o.id, { stroke: v ? { color: "#111114", width: 6 } : undefined })
            }
          >
            {o.stroke && (
              <>
                <Row label="Color">
                  <ColorField
                    value={o.stroke.color}
                    label="Outline color"
                    onBegin={() => useEditor.getState().pushHistory()}
                    onLive={(c) =>
                      useEditor.getState().updateOverlayTransient(o.id, {
                        stroke: { ...o.stroke!, color: c },
                      })
                    }
                    onCommit={(c) => update(o.id, { stroke: { ...o.stroke!, color: c } })}
                  />
                </Row>
                <Row label="Width">
                  <ValueSlider
                    label="Outline width"
                    sliderClassName="data-horizontal:w-24"
                    valueClassName="w-9 text-muted-foreground"
                    value={o.stroke.width}
                    min={1}
                    max={40}
                    step={1}
                    snap={[6]}
                    format={(v) => String(Math.round(v))}
                    parse={parseNumberInput}
                    onDraft={(v) => {
                      strokeCk.begin();
                      useEditor.getState().updateOverlayTransient(o.id, {
                        stroke: { ...o.stroke!, width: Math.round(v) },
                      });
                    }}
                    onCommit={(v) => {
                      strokeCk.begin();
                      useEditor.getState().updateOverlayTransient(o.id, {
                        stroke: { ...o.stroke!, width: Math.round(v) },
                      });
                      strokeCk.end();
                    }}
                  />
                </Row>
              </>
            )}
          </Section>
        )}
        <OverlayMaskSection overlay={o} />
        <TransformRows overlay={o} />
        <GroupRow overlay={o} />
        <AnimationSection
          overlay={o}
          onOpen={nav.open}
          reveal={nav.view === "returned"}
        />
      </div>
    </>
  );
}

function EffectPanel({ overlay: o }: { overlay: EffectOverlay }) {
  const amountCk = useSliderCheckpoint();
  return (
    <>
      <PanelTitle>{EFFECT_LABELS[o.effect]}</PanelTitle>
      {/* Which effect this is belongs to the Effects tab: it marks this one and
          swaps it on a click, so the panel is only its knobs. */}
      <div className="flex flex-col gap-1 px-3.5 pb-4">
        {o.effect === "zoom" ? (
          <ZoomTarget overlay={o} />
        ) : (
          <Row label="Amount">
            <ValueSlider
              label="Effect amount"
              sliderClassName="data-horizontal:w-24"
              valueClassName="w-9 text-muted-foreground"
              value={o.amount ?? 0.5}
              min={0.05}
              max={1}
              step={0.01}
              snap={[0.5]}
              format={(v) => String(Math.round(v * 100))}
              parse={parsePercentInput}
              onDraft={(v) => {
                amountCk.begin();
                useEditor.getState().updateOverlayTransient(o.id, { amount: v });
              }}
              onCommit={(v) => {
                amountCk.begin();
                useEditor.getState().updateOverlayTransient(o.id, { amount: v });
                amountCk.end();
              }}
            />
          </Row>
        )}
        <HiddenRow overlay={o} />
        <GroupRow overlay={o} />
      </div>
    </>
  );
}

/** The focus puck's diameter, in px — `size-5` on the element below. */
const PUCK = 20;

/**
 * Where a zoom lands and how close it gets.
 *
 * The stage mirrors the live preview, so the point is chosen against the
 * picture the zoom will sit on: drag the puck onto what matters. Depth is
 * three steps — a zoom is a choice of how close, and a slider of it is a
 * decision nobody wants to make twice.
 */
function ZoomTarget({ overlay: o }: { overlay: EffectOverlay }) {
  const aspect = useEditor((s) => s.aspect);
  const frame = frameOf(aspect);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const portrait = frame.h > frame.w;
  const focus = { x: o.focus?.x ?? 0.5, y: o.focus?.y ?? 0.5 };
  const amount = o.amount ?? 0.5;
  // How long the push in takes: the far left is a cut straight to the close
  // shot, everything right of it moves the camera in over that many seconds.
  const ramp = zoomRampOf(o.ramp);
  const rampCk = useSliderCheckpoint();

  useEffect(() => {
    let raf = 0;
    const tick = () => {
      raf = requestAnimationFrame(tick);
      const dst = canvasRef.current;
      const src = getPreviewCanvas();
      const ctx = dst?.getContext("2d");
      if (!dst || !src || !ctx) return;
      ctx.clearRect(0, 0, dst.width, dst.height);
      ctx.drawImage(src, 0, 0, dst.width, dst.height);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, []);

  const aim = (e: React.PointerEvent<HTMLDivElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    useEditor.getState().updateOverlayTransient(o.id, {
      focus: {
        x: Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)),
        y: Math.max(0, Math.min(1, (e.clientY - r.top) / r.height)),
      },
    });
  };

  return (
    <div className="flex flex-col items-center gap-2 pt-1">
      <div
        className="relative cursor-grab overflow-hidden rounded-lg bg-black select-none active:cursor-grabbing"
        style={{
          aspectRatio: `${frame.w} / ${frame.h}`,
          height: portrait ? 168 : undefined,
          width: portrait ? undefined : "100%",
        }}
        onPointerDown={(e) => {
          if (e.button !== 0) return;
          e.currentTarget.setPointerCapture(e.pointerId);
          useEditor.getState().pushHistory();
          aim(e);
        }}
        onPointerMove={(e) => {
          if (e.buttons & 1) aim(e);
        }}
      >
        <canvas
          ref={canvasRef}
          width={Math.round(frame.w / 5)}
          height={Math.round(frame.h / 5)}
          className="pointer-events-none block size-full"
        />
        {/* The puck rides its point, pulled back by its own radius at the
            edges so the whole of it stays on the picture. */}
        <div
          className="pointer-events-none absolute size-5 -translate-x-1/2 -translate-y-1/2 rounded-full bg-[#0a84ff] ring-2 ring-white/90 shadow-[0_1px_4px_rgba(0,0,0,0.45)]"
          style={{
            left: `calc(${focus.x * 100}% + ${((0.5 - focus.x) * PUCK).toFixed(2)}px)`,
            top: `calc(${focus.y * 100}% + ${((0.5 - focus.y) * PUCK).toFixed(2)}px)`,
          }}
        />
      </div>
      <div className="flex w-full flex-col">
        <Row label="Depth" grow>
          {/* The segmented control the rest of the inspector uses — bordered
              box, dark pill on the chosen one — stretched over the row's
              free width. */}
          <div className="flex min-w-0 grow rounded-lg border border-input p-0.5 text-[11.5px] font-medium">
            {ZOOM_LEVELS.map((l) => (
              <button
                key={l.id}
                type="button"
                aria-pressed={Math.abs(amount - l.amount) < 0.01}
                className={cn(
                  `zoom-${l.id} flex-1 rounded-md px-1 py-1 whitespace-nowrap transition-colors`,
                  Math.abs(amount - l.amount) < 0.01
                    ? "bg-neutral-900 text-white"
                    : "text-muted-foreground hover:text-foreground"
                )}
                onClick={() => useEditor.getState().updateOverlay(o.id, { amount: l.amount })}
              >
                {l.label}
              </button>
            ))}
          </div>
        </Row>
        <Row label="Speed">
          <ValueSlider
            label="Zoom speed"
            sliderClassName="data-horizontal:w-24"
            valueClassName="w-9 text-muted-foreground"
            value={ramp}
            min={0}
            max={ZOOM_RAMP_MAX}
            step={0.1}
            format={(v) => `${v.toFixed(1)}s`}
            parse={parseSecondsInput}
            onDraft={(v) => {
              rampCk.begin();
              useEditor.getState().updateOverlayTransient(o.id, { ramp: v });
            }}
            onCommit={(v) => {
              rampCk.begin();
              useEditor.getState().updateOverlayTransient(o.id, { ramp: v });
              rampCk.end();
            }}
          />
        </Row>
      </div>
    </div>
  );
}

function StickerPanel({ overlay: o }: { overlay: StickerOverlay }) {
  const widthCk = useSliderCheckpoint();
  const asset = useEditor((s) =>
    o.assetId ? s.assets.find((a) => a.id === o.assetId) : undefined
  );
  const nav = useAnimNav();
  return (
    <>
      <PanelTitle>Sticker</PanelTitle>
      <div className="flex flex-col gap-1 px-3.5 pb-4">
        {asset ? (
          <div className="mb-1 truncate text-[12px] text-muted-foreground" title={asset.name}>
            {asset.name}
          </div>
        ) : null}
        <Row label="Size">
          <ValueSlider
            label="Sticker size"
            sliderClassName="data-horizontal:w-24"
            valueClassName="w-9 text-muted-foreground"
            value={o.w}
            min={0.02}
            max={1}
            step={0.01}
            format={(v) => String(Math.round(v * 100))}
            parse={parsePercentInput}
            onDraft={(v) => {
              widthCk.begin();
              useEditor.getState().updateOverlayTransient(o.id, { w: v });
            }}
            onCommit={(v) => {
              widthCk.begin();
              useEditor.getState().updateOverlayTransient(o.id, { w: v });
              widthCk.end();
            }}
          />
        </Row>
        <OverlayMaskSection overlay={o} />
        <TransformRows overlay={o} />
        <GroupRow overlay={o} />
        <AnimationSection
          overlay={o}
          onOpen={nav.open}
          reveal={nav.view === "returned"}
        />
      </div>
    </>
  );
}
