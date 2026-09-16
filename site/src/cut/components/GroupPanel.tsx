"use client";

import { useMemo } from "react";
import { Bold, Italic, Type } from "lucide-react";
import { hasOverlayKeys, lineLikeShape, poseAt } from "@donkeycut/effects-kit";
import { ColorField } from "@/cut/components/ColorField";
import { FontPicker } from "@/cut/components/FontPicker";
import { NumberField } from "@/cut/components/NumberField";
import { Field, Row, Section, SegGroup, SegToggle, useSliderCheckpoint, Value } from "@/cut/components/panelBits";
import { parseNumberInput, parsePercentInput, parseSecondsInput, ScrubValue } from "@/cut/components/ScrubValue";
import { ValueSlider } from "@/cut/components/ValueSlider";
import { Switch } from "@/components/ui/switch";
import { selectionCenter, selectionSummary, selectionTranslation, sharedNumber, sharedValue } from "@/cut/lib/groupEdit";
import { usePreviewTime } from "@/cut/lib/playhead";
import { clipWindow, maxClipFade, useEditor } from "@/cut/lib/store";
import { TEXT_SIZES } from "@/cut/lib/textStyle";
import {
  clampOverlayPos,
  clipKeyed,
  clipPoseAt,
  isShapeOverlay,
  isTextOverlay,
  type AudioClip,
  type Overlay,
  type OverlayPatch,
  type Selection,
  type ShapeOverlay,
  type TextOverlay,
  type VideoClip,
} from "@/cut/lib/types";

/**
 * The panel for several items at once: a group, or any multi-selection. It
 * shows the fields every selected item has, reads a field as one value when
 * they agree and as Mixed when they differ, and writes every edit to all of
 * them in one undo step. Fields one kind has and another lacks stay off the
 * panel, so a selection of shapes and titles edits its transform and nothing
 * a shape cannot carry.
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
  const onlyOverlays = !items.clips.length && !items.audios.length;
  return (
    <>
      <div className="flex h-10 shrink-0 items-center px-3.5">
        <span className="truncate text-sm font-semibold tracking-tight">{title}</span>
      </div>
      <div className="flex flex-col gap-1 px-3.5 pb-4">
        <div className="mb-1 text-[11px] text-muted-foreground">{selectionSummary(items)}</div>
        {onlyOverlays && texts.length === items.overlays.length && <TextRows texts={texts} />}
        {onlyOverlays && shapes.length === items.overlays.length && <ShapeRows shapes={shapes} />}
        {!items.clips.length && !items.overlays.length && <AudioRows audios={items.audios} />}
        <TransformRows items={items} />
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
  };
}

const patchOverlays = (overlays: readonly Overlay[], patch: (o: Overlay) => OverlayPatch) =>
  st().updateOverlaysTransient(overlays.map((o) => ({ id: o.id, patch: patch(o) })));
const patchClips = (clips: readonly VideoClip[], patch: (c: VideoClip) => Partial<VideoClip>) =>
  st().updateClipsTransient(clips.map((c) => ({ id: c.id, patch: patch(c) })));
const patchAudios = (audios: readonly AudioClip[], patch: (a: AudioClip) => Partial<AudioClip>) =>
  st().updateAudiosTransient(audios.map((a) => ({ id: a.id, patch: patch(a) })));

const SLIDER = { sliderClassName: "data-horizontal:w-24", valueClassName: "w-9 text-muted-foreground" };

function MixedSwitch({ label, values, onChange }: { label: string; values: boolean[]; onChange: (v: boolean) => void }) {
  const shared = sharedValue(values);
  return (
    <Row label={label}>
      {shared.mixed && <Value className="text-muted-foreground italic">Mixed</Value>}
      <Switch checked={!shared.mixed && shared.value} onCheckedChange={onChange} aria-label={label} />
    </Row>
  );
}

/**
 * Position, rotation, opacity and hidden, over whichever of the selection
 * carries them. Position is the selection's center and moves the whole set
 * with its offsets kept; rotation and opacity land the same value on each
 * item. A keyed item takes the edit at the playhead, as its own panel does.
 */
function TransformRows({ items }: { items: { overlays: Overlay[]; clips: VideoClip[]; audios: AudioClip[] } }) {
  const write = useGroupWrite();
  const now = usePreviewTime();
  const { overlays, clips, audios } = items;
  const visual = !audios.length;
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
      ...(patch.opacity !== undefined ? { opacity: patch.opacity >= 0.995 ? undefined : patch.opacity } : {}),
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
  const hidden = [...overlays.map((o) => !!o.hidden), ...clips.map((c) => !!c.hidden), ...audios.map((a) => !!a.hidden)];
  const hiddenRow = (
    <MixedSwitch
      label="Hidden"
      values={hidden}
      onChange={(v) =>
        write.once(() => {
          patchOverlays(overlays, () => ({ hidden: v || undefined }));
          patchClips(clips, () => ({ hidden: v }));
          patchAudios(audios, () => ({ hidden: v }));
        })
      }
    />
  );
  // Sound has no transform: a selection with audio in it shares only Hidden.
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

/** Face, size, weight, slant and color, over a selection of titles only. */
function TextRows({ texts }: { texts: TextOverlay[] }) {
  const write = useGroupWrite();
  const font = sharedValue(texts.map((t) => t.font));
  const size = sharedNumber(texts.map((t) => t.size));
  const bold = sharedValue(texts.map((t) => t.weight === 700));
  const italic = sharedValue(texts.map((t) => !!t.italic));
  const color = sharedValue(texts.map((t) => t.color.toLowerCase()));
  const set = (patch: OverlayPatch) => patchOverlays(texts, () => patch);
  return (
    <>
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
        </Section>
      )}
    </>
  );
}

/** Volume and fades, over a selection of audio clips only. */
function AudioRows({ audios }: { audios: AudioClip[] }) {
  const write = useGroupWrite();
  const volume = sharedNumber(audios.map((a) => a.volume));
  const fadeIn = sharedNumber(audios.map((a) => a.fadeIn ?? 0));
  const fadeOut = sharedNumber(audios.map((a) => a.fadeOut ?? 0));
  const maxFade = Math.min(...audios.map(maxClipFade));
  const set = (patch: Partial<AudioClip>) => patchAudios(audios, () => patch);
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
        onDraft={(v) => write.draft(() => set({ [key]: v }))}
        onCommit={(v) => write.commit(() => set({ [key]: v }))}
      />
    </Row>
  );
  return (
    <>
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
          format={(v) => `${Math.round(v * 100)}%`}
          parse={parsePercentInput}
          onDraft={(v) => write.draft(() => set({ volume: v }))}
          onCommit={(v) => write.commit(() => set({ volume: v }))}
        />
      </Row>
      {fadeRow("Fade in", "fadeIn", fadeIn)}
      {fadeRow("Fade out", "fadeOut", fadeOut)}
    </>
  );
}
