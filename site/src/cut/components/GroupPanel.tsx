"use client";

import { useMemo, useState } from "react";
import { AlignCenter, AlignHorizontalSpaceAround, AlignLeft, AlignRight, AlignVerticalSpaceAround, Bold, FlipHorizontal2, FlipVertical2, Italic, StretchHorizontal, StretchVertical, Type } from "lucide-react";
import { hasOverlayKeys, hasSpeedCurve, lineLikeShape, poseAt, retimeOf, ZOOM_LEVELS, ZOOM_RAMP_MAX, zoomRampOf } from "@donkeycut/effects-kit";
import { ColorField } from "@/cut/components/ColorField";
import { FontPicker } from "@/cut/components/FontPicker";
import { LETTER_SPACINGS, LINE_HEIGHTS, SoundQualityPanel, SoundQualityRow, STRETCHES, StylePresetsRow } from "@/cut/components/Inspector";
import { NumberField } from "@/cut/components/NumberField";
import { Field, Row, Section, SegGroup, SegToggle, useSliderCheckpoint, Value } from "@/cut/components/panelBits";
import { parseNumberInput, parsePercentInput, parseSecondsInput, parseSpeedInput, ScrubValue } from "@/cut/components/ScrubValue";
import { ValueSlider } from "@/cut/components/ValueSlider";
import { Switch } from "@/components/ui/switch";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { selectionCenter, selectionSummary, selectionTranslation, sharedNumber, sharedValue } from "@/cut/lib/groupEdit";
import { usePanelState } from "@/cut/lib/panelState";
import { usePreviewTime } from "@/cut/lib/playhead";
import { clipWindow, maxClipFade, useEditor } from "@/cut/lib/store";
import { PLATE_COLOR, PLATE_OPACITY, PLATE_RADIUS } from "@/cut/lib/textRender";
import { TEXT_SIZES } from "@/cut/lib/textStyle";
import {
  clampOverlayPos,
  CLIP_MAX_ZOOM,
  clipKeyed,
  clipPoseAt,
  clipZoom,
  isEffectOverlay,
  isShapeOverlay,
  isStickerOverlay,
  isTextOverlay,
  SPEED_FLOOR,
  SPEED_MAX,
  SPEED_MIN,
  type AudioClip,
  type BoxStyle,
  type ClipShadow,
  type ClipSound,
  type EffectOverlay,
  type Overlay,
  type OverlayPatch,
  type Selection,
  type ShapeOverlay,
  type StickerOverlay,
  type TextOverlay,
  type VideoClip,
} from "@/cut/lib/types";
import { cn } from "@/lib/utils";

/**
 * The panel for several items at once: a group, or any multi-selection. It
 * shows the fields every selected item has, reads a field as one value when
 * they agree and as Mixed when they differ, and writes every edit to all of
 * them in one undo step. Fields one kind has and another lacks stay off the
 * panel, so a selection of shapes and titles edits its transform and nothing
 * a shape cannot carry. Each kind's own rows mirror its single-item panel:
 * what one title, clip, shape, sticker or effect can set, several can.
 */
export function GroupPanel({ selection }: { selection: readonly NonNullable<Selection>[] }) {
  const overlays = useEditor((s) => s.overlays);
  const clips = useEditor((s) => s.clips);
  const audios = useEditor((s) => s.audioClips);
  const items = useMemo(() => {
    const ids = { overlay: new Set<string>(), clip: new Set<string>(), audio: new Set<string>() };
    for (const sel of selection) if (sel.kind in ids) ids[sel.kind as keyof typeof ids].add(sel.id);
    return {
      overlays: overlays.filter((o) => ids.overlay.has(o.id)),
      clips: clips.filter((c) => ids.clip.has(c.id)),
      audios: audios.filter((a) => ids.audio.has(a.id)),
    };
  }, [selection, overlays, clips, audios]);
  const all = [...items.overlays, ...items.clips, ...items.audios];
  const group = sharedValue(all.map((it) => it.groupId));
  const title = !group.mixed && group.value ? "Group" : `${all.length} items`;
  const texts = items.overlays.filter(isTextOverlay);
  const shapes = items.overlays.filter(isShapeOverlay);
  const stickers = items.overlays.filter(isStickerOverlay);
  const effects = items.overlays.filter(isEffectOverlay);
  const onlyOverlays = !items.clips.length && !items.audios.length;
  const onlyClips = items.clips.length > 0 && !items.audios.length && !items.overlays.length;
  const key = `group:${selection.map((s) => s.id).join()}`;
  // The sound quality view pushes over the panel, as it does on one clip.
  const [view, setView] = usePanelState<"main" | "sound">(key, "soundView", "main");
  const write = useGroupWrite();
  if (view === "sound" && !items.overlays.length) {
    const sound = items.clips[0]?.sound ?? items.audios[0]?.sound;
    return (
      <SoundQualityPanel
        itemId={key}
        sound={sound}
        write={(next, phase) => {
          const run = () => {
            patchClips(items.clips, () => ({ sound: next }));
            patchAudios(items.audios, () => ({ sound: next }));
          };
          if (phase === "commit") write.commit(run);
          else write.draft(run);
        }}
        onBack={() => setView("main")}
      />
    );
  }
  return (
    <>
      <div className="flex h-10 shrink-0 items-center px-3.5">
        <span className="truncate text-sm font-semibold tracking-tight">{title}</span>
      </div>
      <div className="flex flex-col gap-1 px-3.5 pb-4">
        <div className="mb-1 text-[11px] text-muted-foreground">{selectionSummary(items)}</div>
        {onlyOverlays && texts.length === items.overlays.length && <TextRows texts={texts} />}
        {onlyOverlays && shapes.length === items.overlays.length && <ShapeRows shapes={shapes} />}
        {onlyOverlays && stickers.length === items.overlays.length && <StickerRows stickers={stickers} />}
        {onlyOverlays && effects.length === items.overlays.length && <EffectRows effects={effects} />}
        {!items.overlays.length && <SoundRows clips={items.clips} audios={items.audios} onOpenSound={() => setView("sound")} />}
        {onlyClips && <ClipPictureRows clips={items.clips} />}
        <TransformRows items={items} />
        {onlyClips && <ClipBorderRows clips={items.clips} />}
        {onlyClips && <ClipShadowRows clips={items.clips} />}
      </div>
    </>
  );
}

const st = () => useEditor.getState();

/** One write per gesture across every item, in a single undo step. */
function useGroupWrite() {
  const ck = useSliderCheckpoint();
  return {
    draft(run: () => void) {
      ck.begin();
      run();
    },
    commit(run: () => void) {
      ck.begin();
      run();
      ck.end();
    },
    once(run: () => void) {
      st().pushHistory();
      run();
    },
    /** Per-item store actions that each seal their own history, run as one step. */
    batch(run: () => void) {
      st().beginHistoryBatch();
      run();
      st().endHistoryBatch();
    },
  };
}

const patchOverlays = (overlays: readonly Overlay[], patch: (o: Overlay) => OverlayPatch) =>
  st().updateOverlaysTransient(overlays.map((o) => ({ id: o.id, patch: patch(o) })));
const patchClips = (clips: readonly VideoClip[], patch: (c: VideoClip) => Partial<VideoClip>) =>
  st().updateClipsTransient(clips.map((c) => ({ id: c.id, patch: patch(c) })));
const patchAudios = (audios: readonly AudioClip[], patch: (a: AudioClip) => Partial<AudioClip>) =>
  st().updateAudiosTransient(audios.map((a) => ({ id: a.id, patch: patch(a) })));

/** The live copy of a clip, so a patch layers on what earlier drag frames wrote. */
const liveClip = (c: VideoClip) => st().clips.find((x) => x.id === c.id) ?? c;

const SLIDER = { sliderClassName: "data-horizontal:w-24", valueClassName: "w-9 text-muted-foreground" };
const formatPercent = (v: number) => `${Math.round(v * 100)}%`;
const formatSpeed = (v: number) => `${v.toFixed(2)}×`;
const parsePercentText = (raw: string) => parseNumberInput(raw.replace(/%$/, ""));

function MixedSwitch({ label, values, onChange }: { label: string; values: boolean[]; onChange: (v: boolean) => void }) {
  const shared = sharedValue(values);
  return (
    <Row label={label}>
      {shared.mixed && <Value className="text-muted-foreground italic">Mixed</Value>}
      <Switch checked={!shared.mixed && shared.value} onCheckedChange={onChange} aria-label={label} />
    </Row>
  );
}

/** A two-way choice over the set, the bordered pill the single panels use;
 * a mixed set lights neither side. */
function MixedSeg<T extends string>({
  options,
  shared,
  onPick,
}: {
  options: readonly { id: T; label: string }[];
  shared: { value: T; mixed: boolean };
  onPick: (id: T) => void;
}) {
  return (
    <div className="flex rounded-lg border border-input p-0.5">
      {options.map((opt) => {
        const active = !shared.mixed && shared.value === opt.id;
        return (
          <button
            key={opt.id}
            type="button"
            className={cn(
              "rounded-md px-2.5 py-1 text-[11.5px] font-medium transition-colors",
              active ? "bg-neutral-900 text-white" : "text-muted-foreground hover:text-foreground"
            )}
            aria-pressed={active}
            onClick={() => onPick(opt.id)}
          >
            {opt.label}
          </button>
        );
      })}
    </div>
  );
}

/**
 * Position, rotation, opacity and hidden, over whichever of the selection
 * carries them. Position is the selection's center and moves the whole set
 * with its offsets kept; rotation and opacity land the same value on each
 * item. A keyed item takes the edit at the playhead, as its own panel does.
 * An effect has no transform: it joins the Hidden row and nothing else.
 */
function TransformRows({ items }: { items: { overlays: Overlay[]; clips: VideoClip[]; audios: AudioClip[] } }) {
  const write = useGroupWrite();
  const now = usePreviewTime();
  const { clips, audios } = items;
  const overlays = items.overlays.filter((o) => !isEffectOverlay(o));
  const visual = !audios.length && (overlays.length > 0 || clips.length > 0);
  const local = (o: { start: number; end: number }) => Math.max(0, Math.min(now - o.start, Math.max(0.1, o.end - o.start)));
  const overlayPose = (o: Overlay) => (hasOverlayKeys(o) ? poseAt(o, local(o)) : { x: o.x, y: o.y, rotation: o.rotation ?? 0, opacity: o.opacity ?? 1 });
  const clipPose = (c: VideoClip) => {
    const win = clipWindow(st().clips, st().assets, c.id);
    const keyed = clipKeyed(c) && win;
    const pose = keyed ? clipPoseAt(c, local({ start: win.start, end: win.start + win.len })) : { rotation: c.rotation ?? 0, opacity: c.opacity ?? 1 };
    return { keyed: !!keyed, tLocal: win ? local({ start: win.start, end: win.start + win.len }) : 0, ...pose };
  };
  const setOverlay = (o: Overlay, patch: { x?: number; y?: number; rotation?: number; opacity?: number }) => {
    if (hasOverlayKeys(o)) return st().setOverlayKey(o.id, local(o), patch, { transient: true });
    const p: OverlayPatch = {};
    if (patch.x !== undefined) p.x = patch.x;
    if (patch.y !== undefined) p.y = patch.y;
    if (patch.rotation !== undefined) p.rotation = patch.rotation === 0 ? undefined : patch.rotation;
    if (patch.opacity !== undefined) p.opacity = patch.opacity >= 0.995 ? undefined : patch.opacity;
    st().updateOverlayTransient(o.id, p);
  };
  const setClip = (c: VideoClip, patch: { rotation?: number; opacity?: number }) => {
    const pose = clipPose(c);
    if (pose.keyed) return st().setClipKey(c.id, pose.tLocal, patch, { transient: true });
    st().updateClipTransient(c.id, {
      ...(patch.rotation !== undefined ? { rotation: patch.rotation === 0 ? undefined : patch.rotation } : {}),
      ...(patch.opacity !== undefined ? { opacity: patch.opacity >= 0.999 ? undefined : patch.opacity } : {}),
    });
  };
  const poses = overlays.map(overlayPose);
  const center = selectionCenter(poses);
  const rotation = sharedNumber([...poses.map((p) => p.rotation), ...clips.map((c) => clipPose(c).rotation)]);
  const opacity = sharedNumber([...poses.map((p) => p.opacity), ...clips.map((c) => clipPose(c).opacity)]);
  const move = (axis: "x" | "y", pct: number) => {
    const target = { ...center, [axis]: clampOverlayPos(pct / 100) };
    const { dx, dy } = selectionTranslation(poses, target);
    overlays.forEach((o, i) => setOverlay(o, { x: poses[i].x + dx, y: poses[i].y + dy }));
  };
  const rotate = (v: number) => {
    const deg = Math.round(v);
    overlays.forEach((o) => setOverlay(o, { rotation: deg }));
    clips.forEach((c) => setClip(c, { rotation: deg }));
  };
  const fade = (v: number) => {
    const a = Math.max(0, Math.min(1, v));
    overlays.forEach((o) => setOverlay(o, { opacity: a }));
    clips.forEach((c) => setClip(c, { opacity: a }));
  };
  const hidden = [...items.overlays.map((o) => !!o.hidden), ...clips.map((c) => !!c.hidden), ...audios.map((a) => !!a.hidden)];
  const hiddenRow = (
    <MixedSwitch
      label="Hidden"
      values={hidden}
      onChange={(v) =>
        write.once(() => {
          patchOverlays(items.overlays, () => ({ hidden: v || undefined }));
          patchClips(clips, () => ({ hidden: v }));
          patchAudios(audios, () => ({ hidden: v }));
        })
      }
    />
  );
  // Sound and effects have no transform: such a selection shares only Hidden.
  if (!visual) return hiddenRow;
  return (
    <Section title="Transform">
      {overlays.length > 0 && !clips.length && (
        <Row label="Position">
          {(["x", "y"] as const).map((axis) => (
            <span key={axis} className="flex items-center gap-1">
              <span className="text-[11px] text-muted-foreground/70 uppercase">{axis}</span>
              <ScrubValue
                label={`${axis.toUpperCase()} position`}
                className="w-9 text-muted-foreground"
                value={center[axis] * 100}
                min={2}
                max={98}
                step={0.5}
                keyStep={1}
                snap={[50]}
                format={(v) => String(Math.round(v))}
                parse={parseNumberInput}
                onScrub={(v) => write.draft(() => move(axis, v))}
                onCommit={(v) => write.commit(() => move(axis, v))}
              />
            </span>
          ))}
        </Row>
      )}
      <Row label="Rotation">
        <ValueSlider
          label="Rotation"
          {...SLIDER}
          value={rotation.value}
          mixed={rotation.mixed}
          min={-180}
          max={180}
          step={1}
          snap={[-90, 0, 90]}
          format={(v) => `${Math.round(v)}°`}
          parse={parseNumberInput}
          onDraft={(v) => write.draft(() => rotate(v))}
          onCommit={(v) => write.commit(() => rotate(v))}
        />
      </Row>
      <Row label="Opacity">
        <ValueSlider
          label="Opacity"
          {...SLIDER}
          value={opacity.value}
          mixed={opacity.mixed}
          min={0}
          max={1}
          step={0.01}
          format={(v) => String(Math.round(v * 100))}
          parse={parsePercentInput}
          onDraft={(v) => write.draft(() => fade(v))}
          onCommit={(v) => write.commit(() => fade(v))}
        />
      </Row>
      {hiddenRow}
    </Section>
  );
}

/** A title's whole look over a selection of titles: saved styles, face,
 * weight and slant, alignment, size, spacing, stretch, color, outline,
 * shadow and backdrop. */
function TextRows({ texts }: { texts: TextOverlay[] }) {
  const write = useGroupWrite();
  const font = sharedValue(texts.map((t) => t.font));
  const size = sharedNumber(texts.map((t) => t.size));
  const bold = sharedValue(texts.map((t) => t.weight === 700));
  const italic = sharedValue(texts.map((t) => !!t.italic));
  const align = sharedValue(texts.map((t) => t.align ?? "center"));
  const lineHeight = sharedNumber(texts.map((t) => t.lineHeight ?? 1.25));
  const letterSpacing = sharedNumber(texts.map((t) => (t.letterSpacing ?? 0) * 100));
  const stretchX = sharedNumber(texts.map((t) => (t.stretchX ?? 1) * 100));
  const stretchY = sharedNumber(texts.map((t) => (t.stretchY ?? 1) * 100));
  const color = sharedValue(texts.map((t) => t.color.toLowerCase()));
  const outlined = texts.every((t) => !!t.stroke);
  const strokeColor = sharedValue(texts.map((t) => t.stroke?.color.toLowerCase() ?? ""));
  const strokeWidth = sharedNumber(texts.map((t) => (t.stroke?.width ?? 0.04) * 100));
  const shadowed = texts.every((t) => !!t.shadow);
  const shadowOf = (t: TextOverlay) => (typeof t.shadow === "object" ? t.shadow : {});
  const shadowColor = sharedValue(texts.map((t) => (shadowOf(t).color ?? "#000000").toLowerCase()));
  const shadowOpacity = sharedNumber(texts.map((t) => shadowOf(t).opacity ?? 0.65));
  const shadowBlur = sharedNumber(texts.map((t) => shadowOf(t).blur ?? 14));
  const plated = texts.every((t) => t.plate);
  const plateColor = sharedValue(texts.map((t) => (t.plateColor ?? PLATE_COLOR).toLowerCase()));
  const plateOpacity = sharedNumber(texts.map((t) => t.plateOpacity ?? PLATE_OPACITY));
  const plateRadius = sharedNumber(texts.map((t) => t.plateRadius ?? PLATE_RADIUS));
  const set = (patch: OverlayPatch) => patchOverlays(texts, () => patch);
  const setEach = (patch: (t: TextOverlay) => OverlayPatch) => patchOverlays(texts, (o) => patch(o as TextOverlay));
  const slide = (label: string, shared: { value: number; mixed: boolean }, range: { min: number; max: number; step: number; snap?: number[] }, format: (v: number) => string, parse: (raw: string) => number | null, apply: (v: number) => void) => (
    <Row label={label}>
      <ValueSlider
        label={label}
        {...SLIDER}
        value={shared.value}
        mixed={shared.mixed}
        min={range.min}
        max={range.max}
        step={range.step}
        snap={range.snap}
        format={format}
        parse={parse}
        onDraft={(v) => write.draft(() => apply(v))}
        onCommit={(v) => write.commit(() => apply(v))}
      />
    </Row>
  );
  return (
    <>
      <StylePresetsRow overlay={texts[0]} peers={texts} />
      <Field label="Font">
        <FontPicker value={font.value} mixed={font.mixed} onChange={(id) => write.once(() => set({ font: id as TextOverlay["font"] }))} />
      </Field>
      <div className="mt-1 flex items-center gap-2">
        <SegGroup>
          <SegToggle label="Bold" active={!bold.mixed && bold.value} onClick={() => write.once(() => set({ weight: bold.mixed || !bold.value ? 700 : 400 }))}>
            <Bold />
          </SegToggle>
          <SegToggle label="Italic" active={!italic.mixed && italic.value} onClick={() => write.once(() => set({ italic: italic.mixed || !italic.value ? true : undefined }))}>
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
              active={!align.mixed && align.value === a}
              onClick={() => write.once(() => set({ align: a === "center" ? undefined : a }))}
            >
              <Icon />
            </SegToggle>
          ))}
        </SegGroup>
        <NumberField
          label="Text size"
          className="ml-auto w-[74px]"
          icon={<Type />}
          value={size.value}
          mixed={size.mixed}
          min={24}
          max={240}
          step={1}
          presets={TEXT_SIZES}
          format={(v) => String(Math.round(v))}
          parse={parseNumberInput}
          onDraft={(v) => write.draft(() => set({ size: v }))}
          onCommit={(v) => write.commit(() => set({ size: v }))}
        />
      </div>
      <div className="mt-1 grid grid-cols-2 gap-2">
        <Field label="Line height">
          <NumberField
            label="Line height"
            icon={<AlignVerticalSpaceAround />}
            value={lineHeight.value}
            mixed={lineHeight.mixed}
            min={0.8}
            max={2}
            step={0.05}
            snap={[1.25]}
            presets={LINE_HEIGHTS}
            format={(v) => v.toFixed(2)}
            parse={parseNumberInput}
            onDraft={(v) => write.draft(() => set({ lineHeight: Math.abs(v - 1.25) < 0.025 ? undefined : v }))}
            onCommit={(v) => write.commit(() => set({ lineHeight: Math.abs(v - 1.25) < 0.025 ? undefined : v }))}
          />
        </Field>
        <Field label="Letter spacing">
          <NumberField
            label="Letter spacing"
            icon={<AlignHorizontalSpaceAround />}
            value={letterSpacing.value}
            mixed={letterSpacing.mixed}
            min={-5}
            max={30}
            step={1}
            snap={[0]}
            presets={LETTER_SPACINGS}
            format={(v) => `${Math.round(v)}%`}
            parse={parsePercentText}
            onDraft={(v) => write.draft(() => set({ letterSpacing: Math.abs(v) < 0.25 ? undefined : v / 100 }))}
            onCommit={(v) => write.commit(() => set({ letterSpacing: Math.abs(v) < 0.25 ? undefined : v / 100 }))}
          />
        </Field>
      </div>
      <div className="mt-1 grid grid-cols-2 gap-2">
        {(
          [
            ["stretchX", "Width", stretchX, StretchHorizontal],
            ["stretchY", "Height", stretchY, StretchVertical],
          ] as const
        ).map(([axis, label, shared, Icon]) => (
          <Field key={axis} label={label}>
            <NumberField
              label={`${label} stretch`}
              icon={<Icon />}
              value={shared.value}
              mixed={shared.mixed}
              min={25}
              max={400}
              step={5}
              snap={[100]}
              presets={STRETCHES}
              format={(v) => `${Math.round(v)}%`}
              parse={parsePercentText}
              onDraft={(v) => write.draft(() => set({ [axis]: Math.abs(v - 100) < 0.5 ? undefined : v / 100 }))}
              onCommit={(v) => write.commit(() => set({ [axis]: Math.abs(v - 100) < 0.5 ? undefined : v / 100 }))}
            />
          </Field>
        ))}
      </div>
      <Row label="Color">
        <ColorField
          value={color.value}
          mixed={color.mixed}
          label="Text color"
          onBegin={() => st().pushHistory()}
          onLive={(c) => set({ color: c })}
          onCommit={(c) => write.once(() => set({ color: c }))}
        />
      </Row>
      <Section
        title="Outline"
        enabled={outlined}
        onEnabledChange={(v) => write.once(() => setEach((t) => ({ stroke: v ? (t.stroke ?? { color: "#111114", width: 0.04 }) : undefined })))}
      >
        {outlined && (
          <>
            <Row label="Color">
              <ColorField
                value={strokeColor.value}
                mixed={strokeColor.mixed}
                label="Outline color"
                onBegin={() => st().pushHistory()}
                onLive={(c) => setEach((t) => ({ stroke: { ...t.stroke!, color: c } }))}
                onCommit={(c) => write.once(() => setEach((t) => ({ stroke: { ...t.stroke!, color: c } })))}
              />
            </Row>
            {slide("Width", strokeWidth, { min: 1, max: 15, step: 0.5, snap: [4] }, (v) => String(Math.round(v)), parseNumberInput, (v) =>
              setEach((t) => ({ stroke: { ...t.stroke!, width: v / 100 } }))
            )}
          </>
        )}
      </Section>
      <Section title="Shadow" enabled={shadowed} onEnabledChange={(v) => write.once(() => set({ shadow: v }))}>
        {shadowed && (
          <>
            <Row label="Color">
              <ColorField
                value={shadowColor.value}
                mixed={shadowColor.mixed}
                label="Shadow color"
                onBegin={() => st().pushHistory()}
                onLive={(c) => setEach((t) => ({ shadow: { ...shadowOf(t), color: c } }))}
                onCommit={(c) => write.once(() => setEach((t) => ({ shadow: { ...shadowOf(t), color: c } })))}
                opacity={{
                  label: "Shadow opacity",
                  value: shadowOpacity.value,
                  mixed: shadowOpacity.mixed,
                  onDraft: (v) => write.draft(() => setEach((t) => ({ shadow: { ...shadowOf(t), opacity: v } }))),
                  onCommit: (v) => write.commit(() => setEach((t) => ({ shadow: { ...shadowOf(t), opacity: v } }))),
                }}
              />
            </Row>
            {slide("Blur", shadowBlur, { min: 0, max: 60, step: 1, snap: [14] }, (v) => String(Math.round(v)), parseNumberInput, (v) =>
              setEach((t) => ({ shadow: { ...shadowOf(t), blur: v } }))
            )}
          </>
        )}
      </Section>
      <Section title="Backdrop" enabled={plated} onEnabledChange={(v) => write.once(() => set({ plate: v }))}>
        {plated && (
          <>
            <Row label="Color">
              <ColorField
                value={plateColor.value}
                mixed={plateColor.mixed}
                label="Backdrop color"
                onBegin={() => st().pushHistory()}
                onLive={(c) => set({ plateColor: c })}
                onCommit={(c) => write.once(() => set({ plateColor: c }))}
                opacity={{
                  label: "Backdrop opacity",
                  value: plateOpacity.value,
                  mixed: plateOpacity.mixed,
                  onDraft: (v) => write.draft(() => set({ plateOpacity: v })),
                  onCommit: (v) => write.commit(() => set({ plateOpacity: v })),
                }}
              />
            </Row>
            {slide("Radius", plateRadius, { min: 0, max: 1, step: 0.01, snap: [PLATE_RADIUS] }, (v) => String(Math.round(v * 100)), parsePercentInput, (v) =>
              set({ plateRadius: v })
            )}
          </>
        )}
      </Section>
    </>
  );
}

/** Fill, corner radius and outline, over a selection of shapes only. */
function ShapeRows({ shapes }: { shapes: ShapeOverlay[] }) {
  const write = useGroupWrite();
  const boxes = shapes.every((s) => !lineLikeShape(s.shape));
  const rects = shapes.every((s) => s.shape === "rect");
  const fill = sharedValue(shapes.map((s) => s.fill.toLowerCase()));
  const fillOpacity = sharedNumber(shapes.map((s) => s.fillOpacity ?? 1));
  const radius = sharedNumber(shapes.map((s) => s.radius ?? 0));
  const outlined = shapes.every((s) => !!s.stroke);
  const strokeColor = sharedValue(shapes.map((s) => s.stroke?.color.toLowerCase() ?? ""));
  const strokeWidth = sharedNumber(shapes.map((s) => s.stroke?.width ?? 0));
  const set = (patch: (s: ShapeOverlay) => OverlayPatch) => patchOverlays(shapes, (o) => patch(o as ShapeOverlay));
  return (
    <>
      <Row label={boxes ? "Fill" : "Color"}>
        <ColorField
          value={fill.value}
          mixed={fill.mixed}
          label={boxes ? "Fill color" : "Shape color"}
          onBegin={() => st().pushHistory()}
          onLive={(c) => set(() => ({ fill: c }))}
          onCommit={(c) => write.once(() => set(() => ({ fill: c })))}
          opacity={
            boxes
              ? {
                  label: "Fill opacity",
                  value: fillOpacity.value,
                  mixed: fillOpacity.mixed,
                  onDraft: (v) => write.draft(() => set(() => ({ fillOpacity: v >= 0.995 ? undefined : v }))),
                  onCommit: (v) => write.commit(() => set(() => ({ fillOpacity: v >= 0.995 ? undefined : v }))),
                }
              : undefined
          }
        />
      </Row>
      {rects && (
        <Row label="Corner radius">
          <ValueSlider
            label="Corner radius"
            {...SLIDER}
            value={radius.value}
            mixed={radius.mixed}
            min={0}
            max={120}
            step={1}
            format={(v) => String(Math.round(v))}
            parse={parseNumberInput}
            onDraft={(v) => write.draft(() => set(() => ({ radius: Math.round(v) || undefined })))}
            onCommit={(v) => write.commit(() => set(() => ({ radius: Math.round(v) || undefined })))}
          />
        </Row>
      )}
      {boxes && (
        <Section
          title="Outline"
          enabled={outlined}
          onEnabledChange={(v) => write.once(() => set((s) => ({ stroke: v ? (s.stroke ?? { color: "#111114", width: 6 }) : undefined })))}
        >
          {outlined && (
            <>
              <Row label="Color">
                <ColorField
                  value={strokeColor.value}
                  mixed={strokeColor.mixed}
                  label="Outline color"
                  onBegin={() => st().pushHistory()}
                  onLive={(c) => set((s) => ({ stroke: { ...s.stroke!, color: c } }))}
                  onCommit={(c) => write.once(() => set((s) => ({ stroke: { ...s.stroke!, color: c } })))}
                />
              </Row>
              <Row label="Width">
                <ValueSlider
                  label="Outline width"
                  {...SLIDER}
                  value={strokeWidth.value}
                  mixed={strokeWidth.mixed}
                  min={1}
                  max={40}
                  step={1}
                  snap={[6]}
                  format={(v) => String(Math.round(v))}
                  parse={parseNumberInput}
                  onDraft={(v) => write.draft(() => set((s) => ({ stroke: { ...s.stroke!, width: Math.round(v) } })))}
                  onCommit={(v) => write.commit(() => set((s) => ({ stroke: { ...s.stroke!, width: Math.round(v) } })))}
                />
              </Row>
            </>
          )}
        </Section>
      )}
    </>
  );
}

/** Size, over a selection of stickers only. */
function StickerRows({ stickers }: { stickers: StickerOverlay[] }) {
  const write = useGroupWrite();
  const size = sharedNumber(stickers.map((s) => s.w));
  return (
    <Row label="Size">
      <ValueSlider
        label="Sticker size"
        {...SLIDER}
        value={size.value}
        mixed={size.mixed}
        min={0.02}
        max={1}
        step={0.01}
        format={(v) => String(Math.round(v * 100))}
        parse={parsePercentInput}
        onDraft={(v) => write.draft(() => patchOverlays(stickers, () => ({ w: v })))}
        onCommit={(v) => write.commit(() => patchOverlays(stickers, () => ({ w: v })))}
      />
    </Row>
  );
}

/** An effect's knobs over a selection of effects: depth and speed when every
 * one is a zoom, amount otherwise. Where a zoom lands is aimed on its own
 * picture, so the focus stays per effect. */
function EffectRows({ effects }: { effects: EffectOverlay[] }) {
  const write = useGroupWrite();
  const amount = sharedNumber(effects.map((e) => e.amount ?? 0.5));
  const set = (patch: OverlayPatch) => patchOverlays(effects, () => patch);
  if (effects.every((e) => e.effect === "zoom")) {
    const ramp = sharedNumber(effects.map((e) => zoomRampOf(e.ramp)));
    return (
      <>
        <Row label="Depth" grow>
          <div className="flex min-w-0 grow rounded-lg border border-input p-0.5 text-[11.5px] font-medium">
            {ZOOM_LEVELS.map((l) => {
              const active = !amount.mixed && Math.abs(amount.value - l.amount) < 0.01;
              return (
                <button
                  key={l.id}
                  type="button"
                  aria-pressed={active}
                  className={cn(
                    "flex-1 rounded-md px-1 py-1 whitespace-nowrap transition-colors",
                    active ? "bg-neutral-900 text-white" : "text-muted-foreground hover:text-foreground"
                  )}
                  onClick={() => write.once(() => set({ amount: l.amount }))}
                >
                  {l.label}
                </button>
              );
            })}
          </div>
        </Row>
        <Row label="Speed">
          <ValueSlider
            label="Zoom speed"
            {...SLIDER}
            value={ramp.value}
            mixed={ramp.mixed}
            min={0}
            max={ZOOM_RAMP_MAX}
            step={0.1}
            format={(v) => `${v.toFixed(1)}s`}
            parse={parseSecondsInput}
            onDraft={(v) => write.draft(() => set({ ramp: v }))}
            onCommit={(v) => write.commit(() => set({ ramp: v }))}
          />
        </Row>
      </>
    );
  }
  return (
    <Row label="Amount">
      <ValueSlider
        label="Effect amount"
        {...SLIDER}
        value={amount.value}
        mixed={amount.mixed}
        min={0.05}
        max={1}
        step={0.01}
        snap={[0.5]}
        format={(v) => String(Math.round(v * 100))}
        parse={parsePercentInput}
        onDraft={(v) => write.draft(() => set({ amount: v }))}
        onCommit={(v) => write.commit(() => set({ amount: v }))}
      />
    </Row>
  );
}

/**
 * Sound over a selection of video and audio clips: speed and reverse, volume,
 * the sound treatment, then what each kind alone carries — mute is the video
 * clip's own switch, ducking and fades belong to soundtrack clips.
 */
function SoundRows({ clips, audios, onOpenSound }: { clips: VideoClip[]; audios: AudioClip[]; onOpenSound: () => void }) {
  const write = useGroupWrite();
  // A clip's rate lands once, on release: changing it resettles the row.
  const [speedDraft, setSpeedDraft] = useState<number | null>(null);
  const speed = sharedNumber([
    ...clips.map((c) => (hasSpeedCurve(c) ? retimeOf(c).rate : (c.speed ?? 1))),
    ...audios.map((a) => retimeOf(a).rate),
  ]);
  const audioSpeed = (v: number) => patchAudios(audios, () => ({ speed: Math.abs(v - 1) < 1e-4 ? undefined : v, speedCurve: undefined }));
  const commitSpeed = (v: number) => {
    setSpeedDraft(null);
    write.batch(() => {
      clips.forEach((c) => st().setClipSpeed(c.id, v));
      write.commit(() => audioSpeed(v));
    });
  };
  const volume = sharedNumber([...clips.map((c) => c.volume ?? 1), ...audios.map((a) => a.volume)]);
  const setVolume = (v: number) => {
    patchClips(clips, () => ({ volume: v === 1 ? undefined : v }));
    patchAudios(audios, () => ({ volume: v }));
  };
  const duck = sharedNumber(audios.map((a) => a.duck ?? 1));
  const fadeIn = sharedNumber(audios.map((a) => a.fadeIn ?? 0));
  const fadeOut = sharedNumber(audios.map((a) => a.fadeOut ?? 0));
  const maxFade = Math.min(...audios.map(maxClipFade));
  const sound: ClipSound | undefined = clips[0]?.sound ?? audios[0]?.sound;
  const fadeRow = (label: string, key: "fadeIn" | "fadeOut", shared: { value: number; mixed: boolean }) => (
    <Row label={label}>
      <ValueSlider
        label={label}
        {...SLIDER}
        value={shared.value}
        mixed={shared.mixed}
        min={0}
        max={maxFade}
        step={0.1}
        format={(v) => `${v.toFixed(1)}s`}
        parse={parseSecondsInput}
        onDraft={(v) => write.draft(() => patchAudios(audios, () => ({ [key]: v })))}
        onCommit={(v) => write.commit(() => patchAudios(audios, () => ({ [key]: v })))}
      />
    </Row>
  );
  return (
    <>
      <Row label="Speed">
        <ValueSlider
          label="Speed"
          {...SLIDER}
          value={speedDraft ?? speed.value}
          mixed={speedDraft === null && speed.mixed}
          min={SPEED_MIN}
          max={SPEED_MAX}
          step={0.05}
          snap={[1]}
          scrubMin={SPEED_FLOOR}
          scrubMax={Infinity}
          format={formatSpeed}
          parse={parseSpeedInput}
          onDraft={(v) => {
            setSpeedDraft(v);
            if (audios.length) write.draft(() => audioSpeed(v));
          }}
          onCommit={commitSpeed}
        />
      </Row>
      <MixedSwitch
        label="Reverse"
        values={[...clips.map((c) => !!c.reverse), ...audios.map((a) => !!a.reverse)]}
        onChange={(v) =>
          write.batch(() => {
            clips.forEach((c) => st().setClipReverse(c.id, v));
            write.once(() => patchAudios(audios, () => ({ reverse: v || undefined })));
          })
        }
      />
      <Row label="Volume">
        <ValueSlider
          label="Volume"
          {...SLIDER}
          value={volume.value}
          mixed={volume.mixed}
          min={0}
          max={3}
          step={0.05}
          snap={[1]}
          format={formatPercent}
          parse={parsePercentInput}
          onDraft={(v) => write.draft(() => setVolume(v))}
          onCommit={(v) => write.commit(() => setVolume(v))}
        />
      </Row>
      {clips.length > 0 && (
        <MixedSwitch
          label="Mute audio"
          values={clips.map((c) => c.muted)}
          onChange={(v) => write.once(() => patchClips(clips, () => ({ muted: v })))}
        />
      )}
      {audios.length > 0 && !clips.length && (
        <Row label="Duck others">
          <ValueSlider
            label="Duck others"
            {...SLIDER}
            value={duck.value}
            mixed={duck.mixed}
            min={0}
            max={1}
            step={0.05}
            format={(v) => (v >= 0.999 ? "Off" : formatPercent(v))}
            parse={(raw) => (raw.trim().toLowerCase() === "off" ? 1 : parsePercentInput(raw))}
            onDraft={(v) => write.draft(() => patchAudios(audios, () => ({ duck: v < 0.999 ? v : undefined })))}
            onCommit={(v) => write.commit(() => patchAudios(audios, () => ({ duck: v < 0.999 ? v : undefined })))}
          />
        </Row>
      )}
      {audios.length > 0 && !clips.length && fadeRow("Fade in", "fadeIn", fadeIn)}
      {audios.length > 0 && !clips.length && fadeRow("Fade out", "fadeOut", fadeOut)}
      <SoundQualityRow sound={sound} onOpen={onOpenSound} />
    </>
  );
}

/** Framing, zoom and flip over a selection of video clips. Pan stays per
 * clip: where a picture has slack depends on that clip's own footage. */
function ClipPictureRows({ clips }: { clips: VideoClip[] }) {
  const write = useGroupWrite();
  const fit = sharedValue(clips.map((c) => c.fit ?? "fit"));
  const zoom = sharedNumber(clips.map(clipZoom));
  const flips = (key: "flipH" | "flipV") => sharedValue(clips.map((c) => !!c[key]));
  return (
    <>
      <Row label="Framing">
        <MixedSeg
          options={[
            { id: "fit", label: "Fit" },
            { id: "fill", label: "Fill" },
          ]}
          shared={fit}
          onPick={(mode) => write.once(() => patchClips(clips, () => ({ fit: mode, panX: 0, panY: 0 })))}
        />
      </Row>
      <Row label="Zoom">
        <ValueSlider
          label="Zoom"
          {...SLIDER}
          value={zoom.value}
          mixed={zoom.mixed}
          min={1}
          max={CLIP_MAX_ZOOM}
          step={0.01}
          snap={[1]}
          keyStep={0.05}
          format={formatPercent}
          parse={parsePercentInput}
          onDraft={(v) => write.draft(() => patchClips(clips, () => ({ zoom: v > 1.001 ? v : undefined })))}
          onCommit={(v) => write.commit(() => patchClips(clips, () => ({ zoom: v > 1.001 ? v : undefined })))}
        />
      </Row>
      <Row label="Flip">
        <div className="flex rounded-lg border border-input p-0.5">
          {(
            [
              ["flipH", "Flip horizontal", FlipHorizontal2],
              ["flipV", "Flip vertical", FlipVertical2],
            ] as const
          ).map(([key, label, Icon]) => {
            const shared = flips(key);
            const active = !shared.mixed && shared.value;
            return (
              <TooltipProvider key={key}>
                <Tooltip>
                  <TooltipTrigger
                    aria-label={label}
                    aria-pressed={active}
                    className={cn(
                      "grid size-6 place-items-center rounded-md transition-colors",
                      active ? "bg-neutral-900 text-white" : "text-muted-foreground hover:text-foreground"
                    )}
                    onClick={() => write.once(() => patchClips(clips, () => ({ [key]: active ? undefined : true })))}
                  >
                    <Icon className="size-3.5" />
                  </TooltipTrigger>
                  <TooltipContent side="bottom">{label}</TooltipContent>
                </Tooltip>
              </TooltipProvider>
            );
          })}
        </div>
      </Row>
    </>
  );
}

/** Corner radius, border width and color over a selection of video clips. */
function ClipBorderRows({ clips }: { clips: VideoClip[] }) {
  const write = useGroupWrite();
  const bordered = clips.every((c) => !!c.boxStyle);
  const width = sharedNumber(clips.map((c) => c.boxStyle?.borderWidth ?? 0));
  const radius = sharedNumber(clips.map((c) => c.boxStyle?.radius ?? 0));
  const color = sharedValue(clips.map((c) => (c.boxStyle?.borderColor ?? "#FFFFFF").toLowerCase()));
  const set = (patch: Partial<BoxStyle>) => patchClips(clips, (c) => ({ boxStyle: { ...liveClip(c).boxStyle, ...patch } }));
  return (
    <Section
      title="Border"
      enabled={bordered}
      onEnabledChange={(v) =>
        write.once(() =>
          patchClips(clips, (c) => ({ boxStyle: v ? (c.boxStyle ?? { radius: 16, borderWidth: 6, borderColor: "#FFFFFF" }) : undefined }))
        )
      }
    >
      {bordered && (
        <>
          <Row label="Width">
            <ScrubValue
              label="Border width"
              className="w-9 text-muted-foreground"
              value={width.value}
              min={0}
              max={60}
              step={1}
              format={(v) => String(Math.round(v))}
              parse={parseNumberInput}
              onScrub={(v) => write.draft(() => set({ borderWidth: v }))}
              onCommit={(v) => write.commit(() => set({ borderWidth: v }))}
            />
          </Row>
          <Row label="Radius">
            <ScrubValue
              label="Corner radius"
              className="w-9 text-muted-foreground"
              value={radius.value}
              min={0}
              max={200}
              step={1}
              format={(v) => String(Math.round(v))}
              parse={parseNumberInput}
              onScrub={(v) => write.draft(() => set({ radius: v }))}
              onCommit={(v) => write.commit(() => set({ radius: v }))}
            />
          </Row>
          <Row label="Color">
            <ColorField
              value={color.value}
              mixed={color.mixed}
              label="Border color"
              onBegin={() => st().pushHistory()}
              onLive={(c) => set({ borderColor: c })}
              onCommit={(c) => write.once(() => set({ borderColor: c }))}
            />
          </Row>
        </>
      )}
    </Section>
  );
}

/** Drop shadow over a selection of video clips. */
function ClipShadowRows({ clips }: { clips: VideoClip[] }) {
  const write = useGroupWrite();
  const shadowed = clips.every((c) => !!c.boxStyle?.shadow);
  const blur = sharedNumber(clips.map((c) => c.boxStyle?.shadow?.blur ?? 24));
  const offsetX = sharedNumber(clips.map((c) => c.boxStyle?.shadow?.x ?? 0));
  const offsetY = sharedNumber(clips.map((c) => c.boxStyle?.shadow?.y ?? 0));
  const opacity = sharedNumber(clips.map((c) => c.boxStyle?.shadow?.opacity ?? 0.35));
  const color = sharedValue(clips.map((c) => (c.boxStyle?.shadow?.color ?? "#000000").toLowerCase()));
  const set = (patch: Partial<ClipShadow>) =>
    patchClips(clips, (c) => {
      const cur = liveClip(c).boxStyle;
      return { boxStyle: { ...cur, shadow: { blur: cur?.shadow?.blur ?? 24, ...cur?.shadow, ...patch } } };
    });
  const scrub = (label: string, shared: { value: number; mixed: boolean }, range: { min: number; max: number }, apply: (v: number) => void) => (
    <ScrubValue
      label={label}
      className="w-9 text-muted-foreground"
      value={shared.value}
      min={range.min}
      max={range.max}
      step={1}
      format={(v) => String(Math.round(v))}
      parse={parseNumberInput}
      onScrub={(v) => write.draft(() => apply(v))}
      onCommit={(v) => write.commit(() => apply(v))}
    />
  );
  return (
    <Section
      title="Shadow"
      enabled={shadowed}
      onEnabledChange={(v) =>
        write.once(() =>
          patchClips(clips, (c) => ({
            boxStyle: v
              ? { ...c.boxStyle, shadow: c.boxStyle?.shadow ?? { blur: 24, y: 12 } }
              : c.boxStyle?.radius || c.boxStyle?.borderWidth
                ? { ...c.boxStyle, shadow: undefined }
                : undefined,
          }))
        )
      }
    >
      {shadowed && (
        <>
          <Row label="Blur">{scrub("Shadow blur", blur, { min: 0, max: 120 }, (v) => set({ blur: v }))}</Row>
          <Row label="Offset">
            {(
              [
                ["x", offsetX],
                ["y", offsetY],
              ] as const
            ).map(([axis, shared]) => (
              <span key={axis} className="flex items-center gap-1">
                <span className="text-[11px] text-muted-foreground/70 uppercase">{axis}</span>
                {scrub(`Shadow ${axis.toUpperCase()} offset`, shared, { min: -120, max: 120 }, (v) => set({ [axis]: Math.round(v) || undefined }))}
              </span>
            ))}
          </Row>
          <Row label="Opacity">
            <ValueSlider
              label="Shadow opacity"
              {...SLIDER}
              value={opacity.value}
              mixed={opacity.mixed}
              min={0}
              max={1}
              step={0.01}
              format={formatPercent}
              parse={parsePercentInput}
              onDraft={(v) => write.draft(() => set({ opacity: v }))}
              onCommit={(v) => write.commit(() => set({ opacity: v }))}
            />
          </Row>
          <Row label="Color">
            <ColorField
              value={color.value}
              mixed={color.mixed}
              label="Shadow color"
              onBegin={() => st().pushHistory()}
              onLive={(c) => set({ color: c })}
              onCommit={(c) => write.once(() => set({ color: c }))}
            />
          </Row>
        </>
      )}
    </Section>
  );
}
