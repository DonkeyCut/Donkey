"use client";

import { useMemo } from "react";
import {
  CAMERA_SCALE_MAX,
  CAMERA_SCALE_MIN,
  CAMERA_WORLD_MAX,
  CAMERA_WORLD_MIN,
  EASE_IDS,
  EASE_LABELS,
  ELEMENT_BLUR_MAX,
  hasOverlayKeys,
  keyIndexAt,
  poseAt,
  removeKeyAt,
  SHUTTER_MAX,
  SHUTTER_MIN,
  upsertKey,
  type CameraKey,
  type EaseId,
} from "@donkeycut/effects-kit";
import { KeyRow } from "@/cut/components/Inspector";
import { Row, Section, useSliderCheckpoint, Value } from "@/cut/components/panelBits";
import { parseNumberInput, parsePercentInput, ScrubValue } from "@/cut/components/ScrubValue";
import { ValueSlider } from "@/cut/components/ValueSlider";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { groupCameraOf, groupCameraPoseAt } from "@/cut/lib/groupCamera";
import { sharedNumber, sharedValue } from "@/cut/lib/groupEdit";
import { cutMotion } from "@/cut/lib/motionSettings";
import { usePreviewTime } from "@/cut/lib/playhead";
import { useEditor } from "@/cut/lib/store";
import { clipPoseAt, isEffectOverlay, type Overlay, type VideoClip } from "@/cut/lib/types";

/**
 * The motion rows an element, a selection of elements, and a group's camera
 * share: blur, the ease out of a key, motion blur, and the camera's own key
 * track. The chat tools write the same fields (update_overlay,
 * set_overlay_keyframes, set_group_camera).
 */

const st = () => useEditor.getState();
const SLIDER = { sliderClassName: "data-horizontal:w-24", valueClassName: "w-9 text-muted-foreground" };
const EASE_ITEMS = Object.fromEntries(EASE_IDS.map((id) => [id, EASE_LABELS[id]]));
const local = (o: { start: number; end: number }, now: number) =>
  Math.max(0, Math.min(now - o.start, Math.max(0.1, o.end - o.start)));

/** The curve out of the key under the playhead. */
function EaseRow({ ease, onPick }: { ease: EaseId | undefined; onPick: (ease: EaseId | undefined) => void }) {
  return (
    <Row label="Ease">
      <Select value={ease ?? "linear"} items={EASE_ITEMS} onValueChange={(id) => onPick(id === "linear" ? undefined : (id as EaseId))}>
        <SelectTrigger className="h-8 w-36 text-[12px]">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {EASE_IDS.map((id) => (
            <SelectItem key={id} value={id} className="text-[12px]">
              {EASE_LABELS[id]}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </Row>
  );
}

/** Motion blur: the switch, and the shutter once it is on. */
function MotionBlurRows({
  shutter,
  onChange,
  ck,
}: {
  shutter: { value: number; mixed: boolean } | null;
  onChange: (motionBlur: number | undefined, phase: "draft" | "commit" | "once") => void;
  ck: ReturnType<typeof useSliderCheckpoint>;
}) {
  return (
    <>
      <Row label="Motion blur">
        {shutter?.mixed && <Value className="text-muted-foreground italic">Mixed</Value>}
        <Switch
          checked={!!shutter && !shutter.mixed}
          onCheckedChange={(on) => onChange(on ? cutMotion().motionBlur : undefined, "once")}
          aria-label="Motion blur"
        />
      </Row>
      {shutter && (
        <Row label="Shutter">
          <ValueSlider
            label="Shutter"
            {...SLIDER}
            value={shutter.value}
            mixed={shutter.mixed}
            min={SHUTTER_MIN}
            max={SHUTTER_MAX}
            step={0.01}
            snap={[0.5]}
            format={(v) => `${Math.round(v * 100)}%`}
            parse={parsePercentInput}
            onDraft={(v) => {
              ck.begin();
              onChange(v, "draft");
            }}
            onCommit={(v) => {
              ck.begin();
              onChange(v, "commit");
              ck.end();
            }}
          />
        </Row>
      )}
    </>
  );
}

function BlurRow({
  blur,
  onSet,
  ck,
}: {
  blur: { value: number; mixed: boolean };
  onSet: (v: number) => void;
  ck: ReturnType<typeof useSliderCheckpoint>;
}) {
  return (
    <Row label="Blur">
      <ValueSlider
        label="Blur"
        {...SLIDER}
        value={blur.value}
        mixed={blur.mixed}
        min={0}
        max={ELEMENT_BLUR_MAX}
        step={0.5}
        format={(v) => `${Math.round(v * 10) / 10}`}
        parse={parseNumberInput}
        onDraft={(v) => {
          ck.begin();
          onSet(v);
        }}
        onCommit={(v) => {
          ck.begin();
          onSet(v);
          ck.end();
        }}
      />
    </Row>
  );
}

/** One element's motion rows: the ease of its key under the playhead, then
 * the blur and motion blur rows a selection shares. */
export function ElementMotionRows({ overlay: o }: { overlay: Overlay }) {
  const now = usePreviewTime();
  const tLocal = local(o, now);
  const here = hasOverlayKeys(o) ? keyIndexAt(o.kf, tLocal) : -1;
  const key = here >= 0 ? o.kf![here] : undefined;
  return (
    <>
      {key && (
        <EaseRow
          ease={key.ease}
          onPick={(ease) => {
            st().pushHistory();
            st().setOverlayKey(o.id, key.t, { ease }, { transient: true });
          }}
        />
      )}
      <GroupMotionRows overlays={[o]} />
    </>
  );
}

/** Blur and motion blur over several elements at once, one undo step per
 * gesture; a keyed element takes the blur at the playhead. */
export function GroupMotionRows({ overlays }: { overlays: readonly Overlay[] }) {
  const now = usePreviewTime();
  const blurCk = useSliderCheckpoint();
  const shutterCk = useSliderCheckpoint();
  const posed = overlays.filter((o) => !isEffectOverlay(o));
  if (!posed.length) return null;
  const blurOf = (o: Overlay) => (hasOverlayKeys(o) ? (poseAt(o, local(o, now)).blur ?? 0) : (o.blur ?? 0));
  const blur = sharedNumber(posed.map(blurOf));
  const on = sharedValue(posed.map((o) => !!o.motionBlur));
  const shutter = sharedNumber(posed.map((o) => o.motionBlur ?? 0));
  const setBlur = (v: number) => {
    const b = Math.max(0, Math.min(ELEMENT_BLUR_MAX, v));
    for (const o of posed) {
      if (hasOverlayKeys(o)) st().setOverlayKey(o.id, local(o, now), { blur: b }, { transient: true });
      else st().updateOverlayTransient(o.id, { blur: b > 0.05 ? b : undefined });
    }
  };
  return (
    <>
      <BlurRow blur={blur} onSet={setBlur} ck={blurCk} />
      <MotionBlurRows
        shutter={on.mixed ? { value: shutter.value, mixed: true } : on.value ? shutter : null}
        ck={shutterCk}
        onChange={(motionBlur, phase) => {
          if (phase === "once") st().pushHistory();
          st().updateOverlaysTransient(posed.map((o) => ({ id: o.id, patch: { motionBlur } })));
        }}
      />
    </>
  );
}

/** A video clip's blur rows: the blur of its key at the playhead, once it
 * has keys (a clip has no resting blur), and its motion blur. `tLocal` is
 * the playhead in the clip's own seconds. */
export function ClipMotionRows({ clip, tLocal }: { clip: VideoClip; tLocal: number }) {
  const blurCk = useSliderCheckpoint();
  const shutterCk = useSliderCheckpoint();
  const keyed = !!clip.kf?.length;
  return (
    <>
      {keyed && (
        <BlurRow
          blur={{ value: clipPoseAt(clip, tLocal).blur ?? 0, mixed: false }}
          ck={blurCk}
          onSet={(v) =>
            st().setClipKey(clip.id, tLocal, { blur: Math.max(0, Math.min(ELEMENT_BLUR_MAX, v)) }, { transient: true })
          }
        />
      )}
      <MotionBlurRows
        shutter={clip.motionBlur ? { value: clip.motionBlur, mixed: false } : null}
        ck={shutterCk}
        onChange={(motionBlur, phase) => {
          if (phase === "once") {
            st().pushHistory();
          }
          st().updateClipTransient(clip.id, { motionBlur });
        }}
      />
    </>
  );
}

/**
 * A group's camera: its key track over the group's span, the pose at the
 * playhead (where the frame's center looks, the zoom, the roll), the ease out
 * of the key here, and the camera's motion blur. Editing a row with keys in
 * play edits the key at the playhead; with none, it sets the first key.
 */
export function GroupCameraSection({ groupId }: { groupId: string }) {
  const overlays = useEditor((s) => s.overlays);
  const seek = useEditor((s) => s.seek);
  const now = usePreviewTime();
  const posCk = useSliderCheckpoint();
  const zoomCk = useSliderCheckpoint();
  const rollCk = useSliderCheckpoint();
  const shutterCk = useSliderCheckpoint();
  const view = useMemo(() => groupCameraOf(overlays, groupId), [overlays, groupId]);
  if (!view) return null;
  const tGroup = local({ start: 0, end: view.end - view.start }, now - view.start);
  const pose = groupCameraPoseAt(view, tGroup);
  const here = keyIndexAt(view.keys, tGroup);
  const key = here >= 0 ? view.keys[here] : undefined;
  const write = (keys: CameraKey[], motionBlur: number | undefined) =>
    st().setGroupCamera(groupId, { keys, ...(motionBlur ? { motionBlur } : {}) }, { transient: true });
  // Read the live track at each write, so a drag layers on its own frames.
  const live = () => groupCameraOf(st().overlays, groupId) ?? view;
  const setKey = (patch: Partial<Omit<CameraKey, "t">>) => {
    const cur = live();
    const existing = cur.keys[keyIndexAt(cur.keys, tGroup)];
    const base = existing ?? { t: tGroup, ...groupCameraPoseAt(cur, tGroup) };
    write(upsertKey(cur.keys, { ...base, ...patch, t: existing?.t ?? tGroup }), cur.motionBlur);
  };
  const keys = view.keys;
  return (
    <Section title="Camera">
      <KeyRow
        element={{ start: view.start, end: view.end }}
        now={now}
        keys={keys}
        onAdd={(t) => {
          st().pushHistory();
          const cur = live();
          write(upsertKey(cur.keys, { t, ...groupCameraPoseAt(cur, t) }), cur.motionBlur);
        }}
        onRemove={(t) => {
          st().pushHistory();
          const cur = live();
          write(removeKeyAt(cur.keys, t), cur.motionBlur);
        }}
        onSeek={seek}
      />
      <Row label="Look at">
        {(["x", "y"] as const).map((axis) => (
          <span key={axis} className="flex items-center gap-1">
            <span className="text-[11px] text-muted-foreground/70 uppercase">{axis}</span>
            <ScrubValue
              label={`Camera ${axis.toUpperCase()}`}
              className="w-9 text-muted-foreground"
              value={pose[axis] * 100}
              min={CAMERA_WORLD_MIN * 100}
              max={CAMERA_WORLD_MAX * 100}
              step={0.5}
              keyStep={1}
              snap={[50]}
              format={(v) => String(Math.round(v))}
              parse={parseNumberInput}
              onScrub={(v) => {
                posCk.begin();
                setKey({ [axis]: v / 100 });
              }}
              onCommit={(v) => {
                posCk.begin();
                setKey({ [axis]: v / 100 });
                posCk.end();
              }}
            />
          </span>
        ))}
      </Row>
      <Row label="Zoom">
        <ValueSlider
          label="Camera zoom"
          {...SLIDER}
          valueClassName="w-12 text-muted-foreground"
          value={pose.scale}
          min={CAMERA_SCALE_MIN}
          max={4}
          scrubMin={CAMERA_SCALE_MIN}
          scrubMax={CAMERA_SCALE_MAX}
          step={0.01}
          snap={[1]}
          keyStep={0.05}
          format={(v) => `${Math.round(v * 100)}%`}
          parse={parsePercentInput}
          onDraft={(v) => {
            zoomCk.begin();
            setKey({ scale: v });
          }}
          onCommit={(v) => {
            zoomCk.begin();
            setKey({ scale: v });
            zoomCk.end();
          }}
        />
      </Row>
      <Row label="Roll">
        <ValueSlider
          label="Camera roll"
          {...SLIDER}
          value={pose.rotation}
          min={-180}
          max={180}
          step={1}
          snap={[-90, 0, 90]}
          format={(v) => `${Math.round(v)}°`}
          parse={parseNumberInput}
          onDraft={(v) => {
            rollCk.begin();
            setKey({ rotation: Math.round(v) });
          }}
          onCommit={(v) => {
            rollCk.begin();
            setKey({ rotation: Math.round(v) });
            rollCk.end();
          }}
        />
      </Row>
      {key && (
        <EaseRow
          ease={key.ease}
          onPick={(ease) => {
            st().pushHistory();
            const cur = live();
            const k = cur.keys[keyIndexAt(cur.keys, key.t)];
            if (k) write(upsertKey(cur.keys, { ...k, ease }), cur.motionBlur);
          }}
        />
      )}
      <MotionBlurRows
        shutter={view.motionBlur ? { value: view.motionBlur, mixed: false } : null}
        ck={shutterCk}
        onChange={(motionBlur, phase) => {
          if (phase === "once") st().pushHistory();
          write(live().keys, motionBlur);
        }}
      />
    </Section>
  );
}
