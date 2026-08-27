"use client";

import { hasOverlayAnim } from "@donkeycut/effects-kit";
import { chatOwner } from "./chatAssets";
import { useGenerate } from "./generate";
import { useMatteBakes } from "./removal/bakeJobs";
import { getClipSpans, overlayLayers, resolveTransitions, totalDuration, useEditor } from "./store";
import { playheadAt, skimAt } from "./playhead";
import { cueWordCount } from "./cueChunk";
import { laneCues, subtitleLaneCount } from "./subtitles";
import { watchSweepActive } from "./watch/sweep";
import { libraryFontId, listLibraryFonts } from "./linkedLibrary";
import {
  clipZoom,
  frameOf,
  rectOf,
  regionLabel,
  uploadedFontId,
  type ClipSpan,
  type Overlay,
  type VideoClip,
} from "./types";

const r = (n: number) => Math.round(n * 100) / 100;

/** The transition this clip applies into the next one, clamped to the live
 * overlap the same way the preview and export are. Null when there's no
 * transition or no next clip. */
function transitionToNext(sp: ClipSpan, index: number, spans: ClipSpan[]) {
  const seconds = sp.clip.transition ?? 0;
  if (seconds <= 0 || index >= spans.length - 1) return null;
  const style = sp.clip.transitionStyle ?? "crossfade";
  return { style, seconds: r(sp.transitionOut) };
}

/** The clip's own effects — entrance/exit animations, box styling, and its
 * color state in the shape the grading tools take: the preset ref plus a
 * compact summary of the manual grade (nonzero sliders verbatim; curves and
 * wheels as presence flags; the touched hue bands by name). */
function clipEffects(clip: VideoClip) {
  const grade = clip.grade;
  const sliders: Record<string, number> = {};
  for (const [k, v] of Object.entries(grade ?? {})) {
    if (typeof v === "number" && v !== 0) sliders[k] = v;
  }
  const color = grade
    ? {
        ...(grade.preset
          ? {
              colorPreset: {
                id: grade.preset.id,
                amount: r(grade.preset.amount ?? 1),
                ...(grade.preset.skin ? { protectSkin: true } : {}),
              },
            }
          : {}),
        ...(Object.keys(sliders).length ? { grade: sliders } : {}),
        ...(grade.curves ? { curves: Object.keys(grade.curves) } : {}),
        ...(grade.wheels ? { wheels: Object.keys(grade.wheels) } : {}),
        ...(grade.hsl ? { hslBands: Object.keys(grade.hsl) } : {}),
      }
    : {};
  return {
    ...(clip.animIn ? { animIn: { style: clip.animIn.style, seconds: r(clip.animIn.seconds) } } : {}),
    ...(clip.animOut
      ? { animOut: { style: clip.animOut.style, seconds: r(clip.animOut.seconds) } }
      : {}),
    ...color,
    ...(clip.boxStyle ? { boxStyle: clip.boxStyle } : {}),
    ...describeRemoval(clip),
  };
}

/** The clip's cutout state: mode, whether its AI matte is ready (and at which
 * tier), a live bake's progress, and the stroke/background riding on it —
 * what set_removal claims must be grounded in. */
function describeRemoval(clip: VideoClip) {
  const rm = clip.removal;
  if (!rm) return {};
  const job = useMatteBakes.getState().jobs[clip.id];
  return {
    removal: {
      mode: rm.mode,
      ...(rm.subject ? { subject: rm.subject } : {}),
      ...(rm.mode === "chroma" && rm.chroma ? { chroma: rm.chroma } : {}),
      ...(rm.mode === "auto" || rm.mode === "custom"
        ? {
            matte: rm.matte ? `ready (${rm.matte.quality === "hq" ? "quality" : "quick"})` : "none",
            ...(job
              ? {
                  bake:
                    job.status === "running"
                      ? `baking ${job.quality === "hq" ? "quality" : "quick"} (${Math.round(job.progress * 100)}%)`
                      : `error: ${job.error ?? "failed"}`,
                }
              : {}),
          }
        : {}),
      ...(rm.stroke
        ? {
            stroke: {
              style: rm.stroke.style,
              color: rm.stroke.color,
              ...(rm.stroke.width !== undefined ? { width: rm.stroke.width } : {}),
            },
          }
        : {}),
      ...(rm.backdrop && rm.backdrop.kind !== "none" ? { background: rm.backdrop } : {}),
    },
  };
}

/** How much written record the per-message snapshot carries before it hands
 * the rest to get_state. */
const NOTE_SNAPSHOT_BUDGET = 3000;

/** An asset's watch notes shaped for the context: whole when they fit (and
 * whenever the caller asked for everything), otherwise each note shortened to
 * an even share of the budget so every span still says what it holds, with
 * `observedText` naming where the rest is. */
function noteFields(
  notes: { from: number; to: number; text: string }[] | undefined,
  full: boolean
): Record<string, unknown> {
  if (!notes || notes.length === 0) return {};
  const size = notes.reduce((sum, n) => sum + n.text.length, 0);
  if (full || size <= NOTE_SNAPSHOT_BUDGET)
    return { observed: notes.map((n) => ({ from: r(n.from), to: r(n.to), text: n.text })) };
  const share = Math.max(120, Math.floor(NOTE_SNAPSHOT_BUDGET / notes.length));
  let trimmed = false;
  const observed = notes.map((n) => {
    if (n.text.length <= share) return { from: r(n.from), to: r(n.to), text: n.text };
    trimmed = true;
    return { from: r(n.from), to: r(n.to), text: `${n.text.slice(0, share).trimEnd()}…` };
  });
  return { observed, ...(trimmed ? { observedText: "shortened here, whole in get_state" } : {}) };
}

/**
 * Compact JSON snapshot of everything the assistant should know: the cut,
 * the selection, what's on screen, and every user-facing setting. Sent with
 * each message and served by the get_state tool.
 *
 * `fullCues` includes the entire transcript. The per-message snapshot leaves
 * it off (a long transcript would inflate every turn's token cost, even ones
 * that never touch captions); the get_state tool passes it so the model can
 * pull every cue on demand.
 *
 * Each chat is independent: it sees the shared project, the Media panel, and
 * the Library, but never another chat's private media or renders. `chatId`
 * scopes that to the asking thread — an explicit id, else the live turn's (or
 * open panel's) owner. Media and jobs a *different* chat still owns are left
 * out; once media is placed on the timeline, filed into Media, or copied to
 * the Library it stops being chat-private and shows to every chat.
 */
export function buildAiContext(opts?: { fullCues?: boolean; chatId?: string | null }) {
  const s = useEditor.getState();
  const cueCap = opts?.fullCues ? Infinity : 60;
  const chatId = opts?.chatId !== undefined ? opts.chatId : chatOwner();
  const placed = new Set([...s.clips, ...s.audioClips].map((c) => c.assetId));
  // An asset still owned by another chat: chat-made, tagged to a different
  // thread, and not yet moved onto the timeline. Placed media is project
  // content, so it stays visible even when a chat made it.
  const ownedByOtherChat = (a: { origin?: string; chatId?: string; id: string }) =>
    a.origin === "chat" && !!a.chatId && a.chatId !== chatId && !placed.has(a.id);
  // A font asset is a typeface, not footage: it is listed under `fonts` with
  // the account's shelf fonts, where a font id is what the model needs.
  const visibleAssets = s.assets.filter((a) => a.type !== "font" && !ownedByOtherChat(a));
  // The cap trims the tail of a huge media list, and a source someone has
  // watched and written up stays regardless of where it sits: the record is
  // what later decisions are made from.
  const shownAssets =
    visibleAssets.length <= cueCap
      ? visibleAssets
      : visibleAssets.filter((a, i) => i < cueCap || (a.watch?.notes?.length ?? 0) > 0);
  const spans = getClipSpans(s.clips, s.assets);
  const duration = totalDuration(s.clips);
  const assetById = new Map(s.assets.map((a) => [a.id, a]));
  const subtitleTracks = subtitleLaneCount(s.subtitles);
  // Scene-run lineage: which plan shot (1-based, what regenerate_shot takes)
  // placed each clip, so "fix this clip" maps straight to a shot revision.
  const shotByClip = new Map(
    (s.genvideo?.shots ?? []).flatMap((sh, i) =>
      sh.timelineClipId ? [[sh.timelineClipId, { n: i + 1, still: sh.status === "failed" }] as const] : []
    )
  );

  const selection = (() => {
    if (!s.selection) return null;
    const { kind, id } = s.selection;
    if (kind === "clip") {
      const sp = spans.find((x) => x.clip.id === id);
      if (sp) {
        return {
          kind,
          id,
          asset: sp.asset.name,
          start: r(sp.start),
          len: r(sp.len),
          muted: sp.clip.muted,
          ...(sp.clip.hidden ? { hidden: true } : {}),
          speed: r(sp.clip.speed ?? 1),
        };
      }
      // A layer clip carries no span (spans are track 0); describe its
      // compositing shape instead.
      const c = s.clips.find((x) => x.id === id);
      return c ? { kind, id, ...describeOverlayClip(c, assetById) } : { kind, id };
    }
    if (kind === "audio") {
      const a = s.audioClips.find((x) => x.id === id);
      return a ? { kind, id, ...describeAudio(a, assetById) } : { kind, id };
    }
    if (kind === "cue") {
      const c = s.subtitles.cues.find((x) => x.id === id);
      return c
        ? { kind, id, text: c.text, start: r(c.start), end: r(c.end), track: c.lane ?? 0 }
        : { kind, id };
    }
    // The selection's kind stays "overlay" (what select/delete take); the
    // element's own kind rides in from describeOverlay as `element`.
    const o = s.overlays.find((x) => x.id === id);
    if (!o) return { kind, id };
    const { kind: element, ...rest } = describeOverlay(o);
    return { kind, id, element, ...rest };
  })();

  return {
    project: {
      id: s.projectId,
      name: s.projectName,
      duration: r(duration),
      aspect: s.aspect,
      frame: `${frameOf(s.aspect).w}x${frameOf(s.aspect).h}`,
      ...(s.fadeIn > 0 ? { fadeIn: r(s.fadeIn) } : {}),
      ...(s.fadeOut > 0 ? { fadeOut: r(s.fadeOut) } : {}),
      background: s.background,
    },
    playhead: r(playheadAt()),
    skimmer: skimAt() === null ? null : r(skimAt()!),
    playing: s.playing,
    selection,
    // Every project asset visible to this chat, timeline-placed or not (media
    // another chat still owns is filtered out above). `origin` marks Cut-made
    // media (generated/voiceover/recording/stock/freeze); no origin = a user
    // import shown in the Media panel.
    // Every font a title or caption can be set in beyond the built-in list:
    // the account's own, off the Library shelf, plus any still living in this
    // project from before fonts moved to the shelf.
    fonts: [
      ...listLibraryFonts().map((f) => ({ id: libraryFontId(f.key), label: f.label })),
      ...s.assets
        .filter((a) => a.type === "font")
        .map((a) => ({ id: uploadedFontId(a.id), label: a.name })),
    ],
    media: shownAssets.map((a) => ({
      id: a.id,
      name: a.name,
      type: a.type,
      duration: r(a.duration),
      ...(a.origin ? { origin: a.origin } : {}),
      // Source spans whose frame map exists (persisted with the project):
      // distinct-moment times and cut candidates recorded by an earlier watch
      // or by the background sweep. The map aims a watch — it is not seen
      // footage; only sheets returned in this chat are. `watching` marks the
      // sweep still filling the rest; the spans grow as segments land.
      ...(a.watch && a.watch.ranges.length > 0
        ? { mapped: a.watch.ranges.map((rg) => ({ from: r(rg.from), to: r(rg.to) })) }
        : {}),
      ...(watchSweepActive(a.id) ? { watching: true } : {}),
      // The written record of this source — what someone looked at these
      // frames and wrote down (note_source). Unlike `mapped`, this IS seen
      // footage, and it survives the contact sheets that showed it, so a
      // source too long to hold in one conversation is decided from here.
      // The snapshot rides every model call, so it carries the notes while
      // they are small and hands the rest to get_state.
      ...noteFields(a.watch?.notes, opts?.fullCues === true),
      // The source's own transcript (built quietly by the sweep; no subtitle
      // track involved). The snapshot carries the verdict; get_state carries
      // the segments — read those for the words instead of inlining audio.
      ...(a.speech
        ? {
            speech: a.speech.noSpeech ? "none" : "transcribed",
            ...(opts?.fullCues && a.speech.segments.length > 0
              ? {
                  transcript: a.speech.segments.map((sg) => ({
                    start: r(sg.start),
                    end: r(sg.end),
                    text: sg.text,
                  })),
                }
              : {}),
          }
        : {}),
    })),
    mediaTruncated: shownAssets.length < visibleAssets.length,
    // AI video renders for this project, live from the job store — what
    // "rendering" claims must be grounded in. A done render names the asset
    // it landed as (already in `media`); a failed one carries its error.
    // Renders another chat launched stay out; chat-less panel renders show to
    // every chat as shared project activity.
    renders: useGenerate
      .getState()
      .jobs.filter(
        (j) =>
          j.kind === "video" &&
          j.projectId === s.projectId &&
          !(j.chatId && j.chatId !== chatId)
      )
      .slice(0, 8)
      .map((j) => ({
        jobId: j.id,
        prompt: j.prompt.length > 80 ? `${j.prompt.slice(0, 77)}…` : j.prompt,
        status: j.status,
        ...(j.status === "running"
          ? { elapsedSec: Math.round((Date.now() - j.startedAt) / 1000) }
          : {}),
        ...(j.status === "done" && j.assetId ? { assetId: j.assetId } : {}),
        ...(j.status === "error" && j.error ? { error: j.error } : {}),
      })),
    videoTrack: spans.map((sp, index) => ({
      index,
      id: sp.clip.id,
      asset: sp.asset.name,
      start: r(sp.start),
      len: r(sp.len),
      in: r(sp.clip.in),
      out: r(sp.clip.out),
      // A still has no source length; report its placed length instead of 0.
      sourceDuration: r(sp.asset.type === "image" ? sp.len : sp.asset.duration),
      muted: sp.clip.muted,
      ...(sp.clip.hidden ? { hidden: true } : {}),
      framing: sp.clip.fit ?? "fit",
      speed: r(sp.clip.speed ?? 1),
      // The generated scene shot this clip came from — sceneShot is the
      // 1-based number regenerate_shot takes; heldStill marks a render that
      // fell back to its keyframe.
      ...(() => {
        const sh = shotByClip.get(sp.clip.id);
        return sh ? { sceneShot: sh.n, ...(sh.still ? { sceneShotHeldStill: true } : {}) } : {};
      })(),
      // Track 0 is free-positioned: empty stretches play black.
      ...(() => {
        const prevEnd = index === 0 ? 0 : spans[index - 1].start + spans[index - 1].len;
        return sp.start - prevEnd > 0.005 ? { gapBefore: r(sp.start - prevEnd) } : {};
      })(),
      ...(() => {
        const t = transitionToNext(sp, index, spans);
        return t ? { transitionToNext: t } : {};
      })(),
      ...(sp.clip.fit === "fill" || clipZoom(sp.clip) > 1
        ? {
            ...(clipZoom(sp.clip) > 1 ? { zoom: r(clipZoom(sp.clip)) } : {}),
            panX: r(sp.clip.panX ?? 0),
            panY: r(sp.clip.panY ?? 0),
          }
        : {}),
      ...(sp.clip.rotation ? { rotation: sp.clip.rotation } : {}),
      ...((sp.clip.opacity ?? 1) < 1 ? { opacity: r(sp.clip.opacity ?? 1) } : {}),
      ...(sp.clip.grade ? { colorGrade: sp.clip.grade } : {}),
      ...(sp.clip.mask ? { mask: sp.clip.mask } : {}),
      ...(sp.clip.kf?.length
        ? { keyframes: sp.clip.kf.map((k) => ({ ...k, t: r(k.t), x: r(k.x), y: r(k.y) })) }
        : {}),
      ...clipEffects(sp.clip),
    })),
    // Video layers composited over track 0 in track order (the topmost
    // full-frame clip covers the rest). Each track carries its own
    // transitions, reported per clip like track 0's.
    overlayVideo: [...new Set(overlayLayers(s.clips).map((c) => c.track))].flatMap((track) => {
      const trackSpans = getClipSpans(s.clips, s.assets, track);
      return trackSpans.map((sp, i) => ({
        id: sp.clip.id,
        ...describeOverlayClip(sp.clip, assetById),
        ...(() => {
          const t = transitionToNext(sp, i, trackSpans);
          return t ? { transitionToNext: t } : {};
        })(),
        ...clipEffects(sp.clip),
      }));
    }),
    // Every transition bar in the doc. A bar is its own object on the
    // transitions row: it plays whatever cut or clip edge its window lines up
    // with, and one lining up with nothing sits parked, playing nothing. The
    // clip-level transitionToNext above only shows bars that landed on a cut,
    // so this is where a parked leftover — the debris a move or a retime
    // leaves — is visible and addressable by id.
    transitions: (() => {
      const roles = resolveTransitions(s.clips, s.transitions);
      return [...s.transitions]
        .sort((a, b) => a.start - b.start)
        .map((t) => {
          const plays = roles.get(t.id) ?? [];
          return {
            id: t.id,
            start: r(t.start),
            seconds: r(t.seconds),
            style: t.style,
            ...(t.hidden ? { hidden: true } : {}),
            ...(plays.length > 0
              ? { plays: plays.map((p) => ({ at: p.kind, clipId: p.clipId })) }
              : { parked: true }),
          };
        });
    })(),
    soundtrack: s.audioClips.map((a) => ({ id: a.id, ...describeAudio(a, assetById) })),
    // Every overlay element on the title lanes: titles, shapes, stickers —
    // each entry carries its `kind`.
    overlays: s.overlays.map((o) => ({ id: o.id, ...describeOverlay(o) })),
    subtitles: {
      count: s.subtitles.cues.length,
      showOnVideo: s.subtitles.showOnVideo,
      showOnTimeline: s.subtitles.showOnTimeline,
      // One language per track; the active track is what the panel edits and
      // what generation/translation writes to.
      activeTrack: s.subtitleLane,
      tracks: Array.from({ length: subtitleTracks }, (_, i) => ({
        track: i,
        locale:
          s.subtitles.tracks?.[i]?.locale ??
          (i === 0 ? s.subtitles.locale ?? "en-US" : undefined),
        cues: laneCues(s.subtitles, i).length,
        ...(s.subtitles.tracks?.[i]?.hidden ? { hidden: true } : {}),
      })),
      // How the captions READ: how many words one holds at a time. Changing it
      // re-cuts every track (set_caption_look words_per_cue).
      wordsPerCue: cueWordCount(s.subtitles),
      status: s.subtitleStatus,
      // A window of cues by default; when truncated the model calls get_state
      // for the whole transcript (e.g. "clean up all the captions").
      cues: s.subtitles.cues.slice(0, cueCap).map((c) => ({
        id: c.id,
        start: r(c.start),
        end: r(c.end),
        text: c.text,
        ...(subtitleTracks > 1 ? { track: c.lane ?? 0 } : {}),
      })),
      cuesTruncated: s.subtitles.cues.length > cueCap,
    },
    publish: s.publish,
    view: {
      pxPerSec: r(s.pxPerSec),
      timelineH: s.timelineH,
      exportDialogOpen: s.exportOpen,
    },
  };
}

function describeAudio(
  a: { assetId: string; start: number; in: number; out: number; volume: number; fadeIn?: number; fadeOut?: number; speed?: number; duck?: number; lane?: number; hidden?: boolean },
  assets: Map<string, { name: string }>
) {
  const speed = a.speed && a.speed > 0 ? a.speed : 1;
  return {
    asset: assets.get(a.assetId)?.name ?? a.assetId,
    start: r(a.start),
    len: r((a.out - a.in) / speed),
    in: r(a.in),
    out: r(a.out),
    volume: r(a.volume),
    fadeIn: r(a.fadeIn ?? 0),
    fadeOut: r(a.fadeOut ?? 0),
    ...(speed !== 1 ? { speed: r(speed) } : {}),
    ...(a.lane ? { lane: a.lane } : {}),
    ...(a.hidden ? { hidden: true } : {}),
    // A voiceover: while it plays, other audio ducks to this gain.
    ...(a.duck !== undefined ? { duck: r(a.duck) } : {}),
  };
}

function describeOverlayClip(c: VideoClip, assets: Map<string, { name: string }>) {
  const speed = c.speed && c.speed > 0 ? c.speed : 1;
  const rect = rectOf(c);
  return {
    asset: assets.get(c.assetId)?.name ?? c.assetId,
    track: c.track,
    start: r(c.start),
    len: r((c.out - c.in) / speed),
    in: r(c.in),
    out: r(c.out),
    muted: c.muted,
    ...(c.hidden ? { hidden: true } : {}),
    // The frame region this layer occupies: Full covers the frame; Top/Bottom/
    // Left/Right split it; PiP floats inside it.
    layout: regionLabel(rect),
    region: { x: r(rect.x), y: r(rect.y), w: r(rect.w), h: r(rect.h) },
    fit: c.fit ?? "fit",
    ...(clipZoom(c) > 1
      ? { zoom: r(clipZoom(c)), panX: r(c.panX ?? 0), panY: r(c.panY ?? 0) }
      : c.fit === "fill"
        ? { panX: r(c.panX ?? 0), panY: r(c.panY ?? 0) }
        : {}),
    ...(c.rotation ? { rotation: c.rotation } : {}),
    ...((c.opacity ?? 1) < 1 ? { opacity: r(c.opacity ?? 1) } : {}),
    ...(speed !== 1 ? { speed: r(speed) } : {}),
    ...(c.grade ? { colorGrade: c.grade } : {}),
    ...(c.mask ? { mask: c.mask } : {}),
    ...(c.boxStyle ? { boxStyle: c.boxStyle } : {}),
    ...(c.kf?.length
      ? { keyframes: c.kf.map((k) => ({ ...k, t: r(k.t), x: r(k.x), y: r(k.y) })) }
      : {}),
  };
}

function describeOverlay(o: Overlay) {
  const base = {
    kind: o.kind ?? "text",
    start: r(o.start),
    end: r(o.end),
    x: r(o.x),
    y: r(o.y),
    ...(o.rotation ? { rotation: o.rotation } : {}),
    ...(o.opacity !== undefined ? { opacity: r(o.opacity) } : {}),
    ...(hasOverlayAnim(o.anim) ? { anim: o.anim } : {}),
    ...(o.kf?.length
      ? { keyframes: o.kf.map((k) => ({ ...k, t: r(k.t), x: r(k.x), y: r(k.y) })) }
      : {}),
    ...(o.mask ? { mask: o.mask } : {}),
    ...(o.lane ? { lane: o.lane } : {}),
    ...(o.hidden ? { hidden: true } : {}),
  };
  if (o.kind === "shape") {
    return {
      ...base,
      shape: o.shape,
      w: r(o.w),
      h: r(o.h),
      fill: o.fill,
      ...(o.fillOpacity !== undefined ? { fillOpacity: r(o.fillOpacity) } : {}),
      ...(o.radius ? { radius: o.radius } : {}),
      ...(o.stroke ? { stroke: o.stroke } : {}),
    };
  }
  if (o.kind === "sticker") {
    return { ...base, assetId: o.assetId, w: r(o.w) };
  }
  if (o.kind === "effect") {
    return {
      ...base,
      effect: o.effect,
      amount: r(o.amount ?? 0.5),
      ...(o.effect === "zoom"
        ? { focus: { x: r(o.focus?.x ?? 0.5), y: r(o.focus?.y ?? 0.5) } }
        : {}),
    };
  }
  return {
    ...base,
    text: o.text,
    size: o.size,
    font: o.font,
    weight: o.weight,
    color: o.color,
    shadow: o.shadow,
    plate: o.plate,
    ...(o.groupId ? { groupId: o.groupId } : {}),
    ...(o.plateRadius !== undefined && { plateRadius: r(o.plateRadius) }),
    ...(o.stretchX !== undefined ? { stretchX: r(o.stretchX) } : {}),
    ...(o.stretchY !== undefined ? { stretchY: r(o.stretchY) } : {}),
  };
}
