"use client";

import { formatBytes } from "@/lib/bytes";
import { isLinkedAssetType, isTimelineId, parkedTimeline, sanitizeTimelines, timelineAspect, TIMELINE_IDS, TIMELINE_LABELS, type TimelineBody, type TimelineId } from "./types";
import { FIND_MEDIA_SNAPSHOT_CAP } from "./findMedia";
import { GUIDE_PRESETS, guideFits, guideGeometry, safeAreaOf, sanitizeGuideLines, sanitizeGuides, type GuideId, type GuideLines } from "./guides";
import { hasOverlayAnim, retimeOf, speedCurveOf, WHEEL_LABELS, WHEEL_ZONES, type ClipSound, type OutputSpace, type SpeedNode } from "@donkeycut/effects-kit";
import { chatOwner } from "./chatAssets";
import { useGenerate } from "./generate";
import { matteBakesAvailable, useMatteBakes } from "./removal/bakeJobs";
import { cardMatteKey, resolveCardShape } from "./cameraCard";
import { assetIdsOnAnyTimeline, deriveTransitionFields, getClipSpans, normalizeDocState, overlayLayers, projectDuration, resolveTransitions, totalDuration, useEditor } from "./store";
import type { VideoProject } from "./genvideo/types";
import { playheadAt, skimAt } from "./playhead";
import { cueWordCount } from "./cueChunk";
import { laneCues, subtitleLaneCount } from "./subtitles";
import { emphasizedWords } from "./captionEmphasis";
import { watchSweepActive } from "./watch/sweep";
import { libraryFontId, listLibraryFonts, listLutChoices } from "./linkedLibrary";
import { savedGradesKnown } from "./gradePresets";
import { sourceProfileOf } from "./baseFrame";
import { groupCameras } from "./groupCamera";
import { isOffline } from "./network";
import {
  clipZoom,
  frameOf,
  rectOf,
  regionLabel,
  uploadedFontId,
  type Aspect,
  type AudioClip,
  type ClipSpan,
  type MediaAsset,
  type MediaFolder,
  overlayName,
  type Overlay,
  type ProjectDoc,
  type SubtitleCue,
  type SubtitlesBlock,
  type TimelineTransition,
  type VideoClip,
} from "./types";

const r = (n: number) => Math.round(n * 100) / 100;
/** Element times to the millisecond: a 60 fps frame is 0.0167 s, which two
 * decimals blur. editor_state and the tool results both read times through it. */
export const roundT = (n: number) => Math.round(n * 1000) / 1000;
/** Frame fractions to the 1/10,000: a pixel of a 1080 frame is 0.0009, which
 * two decimals blur by up to five pixels. */
const rF = (n: number) => Math.round(n * 10000) / 10000;

/** The transition this clip applies into the next one, clamped to the live
 * overlap the same way the preview and export are. Null when there's no
 * transition or no next clip. */
function transitionToNext(sp: ClipSpan, index: number, spans: ClipSpan[]) {
  const seconds = sp.clip.transition ?? 0;
  if (seconds <= 0 || index >= spans.length - 1) return null;
  const style = sp.clip.transitionStyle ?? "crossfade";
  return {
    style,
    seconds: roundT(sp.transitionOut),
    ...(sp.clip.transitionFeather ? { feather: sp.clip.transitionFeather } : {}),
    ...(sp.clip.transitionBand ? { band: sp.clip.transitionBand } : {}),
  };
}

/** The clip's own effects — entrance/exit animations, box styling, and its
 * color state in the shape the grading tools take: the LUT and the preset
 * refs plus a compact summary of the manual grade (nonzero sliders verbatim;
 * curves as presence flags; the wheels by their tool names; the touched hue
 * bands by name). */
function clipEffects(clip: VideoClip, live: boolean, frame?: CardFrame) {
  const grade = clip.grade;
  const sliders: Record<string, number> = {};
  for (const [k, v] of Object.entries(grade ?? {})) {
    if (typeof v === "number" && v !== 0) sliders[k] = v;
  }
  const color = grade
    ? {
        ...(grade.lut ? { lut: { id: grade.lut.id, amount: r(grade.lut.amount ?? 1) } } : {}),
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
        ...(grade.wheels
          ? { wheels: WHEEL_ZONES.filter((z) => grade.wheels?.[z]).map((z) => WHEEL_LABELS[z].toLowerCase()) }
          : {}),
        ...(grade.hsl ? { hslBands: Object.keys(grade.hsl) } : {}),
      }
    : {};
  return {
    ...(clip.animIn ? { animIn: { style: clip.animIn.style, seconds: roundT(clip.animIn.seconds) } } : {}),
    ...(clip.animOut
      ? { animOut: { style: clip.animOut.style, seconds: roundT(clip.animOut.seconds) } }
      : {}),
    ...color,
    ...(clip.effects?.length ? { effects: clip.effects } : {}),
    ...(clip.boxStyle ? { boxStyle: clip.boxStyle } : {}),
    ...describeRemoval(clip, live),
    ...(clip.card ? { card: describeCameraCard(clip, live, frame) } : {}),
  };
}

/** What a camera card's defaults read: the frame shape and the clip's
 * source. */
interface CardFrame {
  aspect: Aspect;
  assetById: Map<string, MediaAsset>;
}

/** The clip's camera-card layout as set_camera_card speaks it — the side,
 * top and width it shows at, with `auto` naming the ones that follow the
 * frame shape and the source — with the head's person matte: "ready", a live bake's progress or error, "off" when
 * the card hides the head, or owed until the editor bakes it — what a claim
 * about the head showing must rest on. */
export function describeCameraCard(clip: VideoClip, live: boolean, frame?: CardFrame) {
  const c = clip.card;
  if (!c) return null;
  const fr = frameOf(frame?.aspect ?? "9:16");
  const rect = rectOf(clip);
  const asset = frame?.assetById.get(clip.assetId);
  const shape = resolveCardShape(c, rect.w * fr.w, rect.h * fr.h, asset?.width ?? 0, asset?.height ?? 0);
  const auto = [
    ...(c.side === undefined ? ["side"] : []),
    ...(c.top === undefined ? ["top"] : []),
    ...(shape.side !== "bottom" && c.width === undefined ? ["width"] : []),
  ];
  const job = live ? useMatteBakes.getState().jobs[cardMatteKey(clip.id)] : undefined;
  const matte = !c.popOut
    ? "off"
    : c.matte
      ? "ready"
      : job?.status === "running"
        ? `baking (${Math.round(job.progress * 100)}%)`
        : job?.status === "error"
          ? `error: ${job.error ?? "failed"}`
          : live && matteBakesAvailable
            ? "starting"
            : "owed: bakes when the project is open in the editor";
  return {
    side: shape.side,
    top: r(shape.top),
    ...(shape.side !== "bottom" ? { width: r(shape.width) } : {}),
    ...(auto.length ? { auto } : {}),
    radius: c.radius,
    side_bleed: c.sideBleed,
    pop_out: c.popOut,
    feather: c.feather,
    shadow: r(c.shadow),
    ...(c.scale !== undefined ? { scale: r(c.scale) } : {}),
    ...(c.offsetX !== undefined ? { offset_x: r(c.offsetX) } : {}),
    ...(c.offsetY !== undefined ? { offset_y: r(c.offsetY) } : {}),
    matte,
  };
}

/** The clip's cutout state: mode, whether its AI matte is ready (and at which
 * tier), a live bake's progress, and the stroke/background riding on it —
 * what set_removal claims must be grounded in. */
function describeRemoval(clip: VideoClip, live: boolean) {
  const rm = clip.removal;
  if (!rm) return {};
  const job = live ? useMatteBakes.getState().jobs[clip.id] : undefined;
  return {
    removal: {
      mode: rm.mode,
      ...(rm.off ? { off: true } : {}),
      removes: rm.invert ? "subject" : "background",
      ...(rm.subject ? { subject: rm.subject } : {}),
      matte: rm.matte ? `ready (${rm.matte.quality === "hq" ? "quality" : "quick"})` : "none",
      ...(job
        ? {
            bake:
              job.status === "running"
                ? `baking ${job.quality === "hq" ? "quality" : "quick"} (${Math.round(job.progress * 100)}%)`
                : `error: ${job.error ?? "failed"}`,
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
    return { observed: notes.map((n) => ({ from: roundT(n.from), to: roundT(n.to), text: n.text })) };
  const share = Math.max(120, Math.floor(NOTE_SNAPSHOT_BUDGET / notes.length));
  let trimmed = false;
  const observed = notes.map((n) => {
    if (n.text.length <= share) return { from: roundT(n.from), to: roundT(n.to), text: n.text };
    trimmed = true;
    return { from: roundT(n.from), to: roundT(n.to), text: `${n.text.slice(0, share).trimEnd()}…` };
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
  const chatId = opts?.chatId !== undefined ? opts.chatId : chatOwner();
  const core = describeState(s, { fullCues: opts?.fullCues === true, chatId, live: true });
  const spans = getClipSpans(s.clips, s.assets);
  const assetById = new Map(s.assets.map((a) => [a.id, a]));

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
          start: roundT(sp.start),
          len: roundT(sp.len),
          muted: sp.clip.muted,
          ...(sp.clip.hidden ? { hidden: true } : {}),
          ...describeRate(sp.clip),
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
        ? { kind, id, text: c.text, start: roundT(c.start), end: roundT(c.end), track: c.lane ?? 0, ...cueExtras(c) }
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
    project: core.project,
    playhead: roundT(playheadAt()),
    skimmer: skimAt() === null ? null : roundT(skimAt()!),
    playing: s.playing,
    selection,
    // Every font a title or caption can be set in beyond the built-in list:
    // the account's own, off the Library shelf, plus any still living in this
    // project from before fonts moved to the shelf.
    fonts: [
      ...listLibraryFonts().map((f) => ({ id: libraryFontId(f.key), label: f.label })),
      ...s.assets
        .filter((a) => a.type === "font")
        .map((a) => ({ id: uploadedFontId(a.id), label: a.name })),
    ],
    // Every LUT set_color_lut takes, by id: the built-in film looks and the
    // user's own files in the Library. The grades saved there, by name, for
    // apply_saved_grade.
    luts: listLutChoices().map((l) => ({ id: l.id, label: l.label, ...(l.builtIn ? { builtIn: true } : {}) })),
    savedGrades: savedGradesKnown().map((g) => ({ id: g.id, name: g.name })),
    ...(core.mediaFolders ? { mediaFolders: core.mediaFolders } : {}),
    media: core.media,
    mediaTruncated: core.mediaTruncated,
    ...(core.mediaInOtherChats ? { mediaInOtherChats: core.mediaInOtherChats, mediaInOtherChatsNote: core.mediaInOtherChatsNote } : {}),
    // The browser has no connection: hosted work (renders, cloud reads,
    // uploads) waits for it, and wait_for_uploads waits with it.
    ...(isOffline() ? { offline: true } : {}),
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
    videoTrack: core.videoTrack,
    overlayVideo: core.overlayVideo,
    transitions: core.transitions,
    soundtrack: core.soundtrack,
    overlays: core.overlays,
    subtitles: core.subtitles,
    publish: s.publish,
    // The Details tab's notes: where the cut keeps its source links.
    ...(s.notes.text || s.notes.publishedAt || s.notes.links.some(Boolean) ? { notes: s.notes } : {}),
    view: {
      pxPerSec: r(s.pxPerSec),
      timelineH: s.timelineH,
      exportDialogOpen: s.exportOpen,
    },
  };
}

/** A parked timeline's items, described the way the open one's are: what
 * get_state reads with `timeline`, so the chat can copy an item another
 * timeline holds without opening it. */
export function describeParkedTimeline(id: TimelineId) {
  const s = useEditor.getState();
  const body = parkedTimeline(s, id);
  const core = describeState({ ...s, ...body, timeline: id }, { fullCues: true, chatId: chatOwner(), live: true });
  return {
    timeline: id,
    aspect: body.aspect,
    duration: roundT(projectDuration(body)),
    videoTrack: core.videoTrack,
    overlayVideo: core.overlayVideo,
    transitions: core.transitions,
    soundtrack: core.soundtrack,
    overlays: core.overlays,
    ...("groupCameras" in core ? { groupCameras: core.groupCameras } : {}),
    subtitles: core.subtitles,
  };
}

/** A stored document described the way the open project is: the same
 * shape the model reads in <editor_state>, built from the document alone.
 * This is how another project is read as a reference — its edit, its
 * sources with their notes and transcripts, its caption look — and it goes
 * through the store's own normalization so an old document reads like a
 * new one. Live-only fields (playhead, selection, renders, view) stay out. */
export function describeDoc(doc: ProjectDoc, opts?: { fullCues?: boolean; chatId?: string | null }) {
  const assets: MediaAsset[] = (doc.assets ?? []).map((a) => ({ ...a, url: "" }));
  const state = normalizeDocState(doc, assets);
  const aspect = state.aspect ?? "9:16";
  const core = describeState(
    {
      projectId: doc.id ?? null,
      projectName: doc.name ?? "",
      assets,
      // The store writes each clip's blend into the clip as it lands; the
      // description reads the same fields.
      clips: deriveTransitionFields(state.clips, state.transitions),
      transitions: state.transitions,
      audioClips: state.audioClips,
      overlays: state.overlays,
      subtitles: state.subtitles,
      subtitleLane: 0,
      subtitleStatus: state.subtitles.cues.length > 0 ? "ready" : "idle",
      aspect,
      background: state.background,
      colorSpace: state.colorSpace,
      magnet: doc.magnet === true,
      guides: sanitizeGuides(doc.guides),
      guideLines: sanitizeGuideLines(doc.guideLines),
      genvideo: doc.genvideo ?? undefined,
      mediaFolders: doc.mediaFolders ?? [],
      timeline: isTimelineId(doc.timeline) ? doc.timeline : "main",
      timelines: sanitizeTimelines(doc.timelines, { aspect }) ?? {},
    },
    { fullCues: opts?.fullCues === true, chatId: opts?.chatId ?? null, live: false }
  );
  const { mediaFolders, ...rest } = core;
  return { ...rest, ...(mediaFolders ? { mediaFolders } : {}) };
}

/** The document-shaped part of the editor's state: what the store holds
 * after opening a project, or a stored document normalized the same way. */
interface DescribedState {
  projectId: string | null;
  projectName: string;
  assets: MediaAsset[];
  clips: VideoClip[];
  transitions: TimelineTransition[];
  audioClips: AudioClip[];
  overlays: Overlay[];
  subtitles: SubtitlesBlock;
  subtitleLane: number;
  subtitleStatus: string;
  aspect: Aspect;
  background: string;
  colorSpace: OutputSpace;
  magnet: boolean;
  guides: GuideId[];
  guideLines: GuideLines;
  genvideo?: VideoProject | null;
  mediaFolders: MediaFolder[];
  timeline: TimelineId;
  timelines: Partial<Record<TimelineId, TimelineBody>>;
}

/** An asset still owned by another chat: chat-made, tagged to a different
 * thread, and not yet moved onto the timeline. Placed media is project
 * content, so it stays visible even when a chat made it. The same rule reads
 * the open project and a reference, so a chat sees no more of a project by
 * reading it as a reference than by opening it. */
export const hiddenFromChat = (
  a: { origin?: string; chatId?: string; id: string },
  chatId: string | null,
  placed: Set<string>
): boolean => a.origin === "chat" && !!a.chatId && a.chatId !== chatId && !placed.has(a.id);

/** What a chat is told about media it can't see: that it exists, so it never
 * says a file is missing from the project, and where it can be cleared. */
export const OTHER_CHATS_MEDIA_NOTE =
  "Some project media belongs to another chat thread, which made it and hasn't placed it, so this chat can't see or delete it. Tell the user it is there: they can clear it from that thread, or delete that thread from the chat history, which removes the unplaced media it owns.";

/** `live` marks the open project: the sweep's progress, the matte bakes in
 * flight, and another chat's private media are facts about this page, and
 * a document read as a reference has none of them. */
function describeState(
  s: DescribedState,
  opts: { fullCues: boolean; chatId: string | null; live: boolean }
) {
  const cueCap = opts.fullCues ? Infinity : 60;
  const chatId = opts.chatId;
  const placed = assetIdsOnAnyTimeline(s);
  const ownedByOtherChat = (a: { origin?: string; chatId?: string; id: string }) =>
    hiddenFromChat(a, chatId, placed);
  // A font asset is a typeface, not footage: it is listed under `fonts` with
  // the account's shelf fonts, where a font id is what the model needs.
  const visibleAssets = s.assets.filter((a) => !isLinkedAssetType(a.type) && !ownedByOtherChat(a));
  const otherChatsMedia = s.assets.filter((a) => !isLinkedAssetType(a.type) && ownedByOtherChat(a)).length;
  // The cap trims the tail of a huge media list, and a source someone has
  // watched and written up stays regardless of where it sits: the record is
  // what later decisions are made from.
  const mediaCap = opts.fullCues ? Infinity : FIND_MEDIA_SNAPSHOT_CAP;
  const shownAssets =
    visibleAssets.length <= mediaCap
      ? visibleAssets
      : visibleAssets.filter((a, i) => i < mediaCap || (a.watch?.notes?.length ?? 0) > 0);
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
  const live = opts.live;

  return {
    project: {
      id: s.projectId,
      name: s.projectName,
      duration: roundT(duration),
      // The open timeline is what everything else here describes; the others
      // are parked until switch_timeline opens one.
      timeline: s.timeline,
      timelines: TIMELINE_IDS.map((id) => {
        const body = id === s.timeline ? s : s.timelines[id];
        return {
          id,
          label: TIMELINE_LABELS[id],
          ...(id === s.timeline ? { open: true } : {}),
          duration: roundT(body ? projectDuration(body) : 0),
          clips: body?.clips.length ?? 0,
          aspect: timelineAspect(s, id),
          // A parked timeline's sound as it is mixed there, so "Main's music"
          // is that clip with its trim and levels (copy_from_timeline).
          ...(id !== s.timeline && body?.audioClips.length
            ? { soundtrack: body.audioClips.map((a) => ({ id: a.id, ...describeAudio(a, assetById) })) }
            : {}),
        };
      }),
      aspect: s.aspect,
      frame: `${frameOf(s.aspect).w}x${frameOf(s.aspect).h}`,
      background: s.background,
      // The delivery's color space (set_project_color): sdr, or hlg / pq
      // for an HDR export and an HDR preview where the display carries it.
      colorSpace: s.colorSpace,
      // The magnet (set_magnet): on, track 0 stays closed up.
      magnet: s.magnet,
      // Every guide preset's safe area for this frame, whether or not it
      // shows, so placement can respect a platform's UI without a guide on:
      // safeArea and keepOut are frame fractions (x, y, w, h).
      safeZones: Object.fromEntries(
        GUIDE_PRESETS.filter((p) => p.id !== "custom" && guideFits(p.id, s.aspect)).flatMap((p) => {
          const safeArea = safeAreaOf([p.id], s.aspect);
          if (!safeArea) return [];
          const keepOut = guideGeometry([p.id], s.aspect).boxes.map((b) => ({
            label: b.label,
            x: rF(b.x),
            y: rF(b.y),
            w: rF(b.w),
            h: rF(b.h),
          }));
          return [[p.id, { safeArea, ...(keepOut.length ? { keepOut } : {}) }]];
        })
      ),
      // The guides showing on the preview and the user's own lines.
      ...(s.guides.length > 0
        ? {
            guides: {
              on: s.guides,
              ...(s.guides.includes("custom") ? { customLines: s.guideLines } : {}),
            },
          }
        : {}),
    },
    // The Media panel's folders, when the project has any; each filed asset
    // carries its folderId below (media_organize moves them).
    mediaFolders:
      s.mediaFolders.length > 0 ? s.mediaFolders.map((f) => ({ id: f.id, name: f.name })) : null,
    // Every project asset visible to this chat, timeline-placed or not (media
    // another chat still owns is filtered out above). `origin` marks Cut-made
    // media (generated/voiceover/recording/stock/freeze/block); no origin = a user
    // import shown in the Media panel.
    media: shownAssets.map((a) => ({
      id: a.id,
      name: a.name,
      type: a.type,
      fileName: a.fileName,
      ...(a.sizeBytes !== undefined ? { sizeBytes: a.sizeBytes, fileSize: formatBytes(a.sizeBytes) } : {}),
      ...(a.width !== undefined ? { width: a.width } : {}),
      ...(a.height !== undefined ? { height: a.height } : {}),
      duration: roundT(a.duration),
      ...(a.origin ? { origin: a.origin } : {}),
      ...(a.folderId != null ? { folderId: a.folderId } : {}),
      // A file on its way to storage plays and reads from the bytes in this
      // browser; `upload` says how far it is, or what stopped it.
      ...(live && a.upload
        ? {
            upload: a.upload.error
              ? { status: "failed", error: a.upload.error }
              : { status: "uploading", percent: Math.round(a.upload.progress * 100) },
          }
        : {}),
      // Where the picture sits inside a recorded frame (find_picture): the
      // box the measuring tools read inside, centre and size as fractions.
      ...(a.picture && (a.picture.w < 1 || a.picture.h < 1) ? { picture: a.picture } : {}),
      // The recording bound to this video (sync_audio): every clip of it
      // plays that file, recording second = video second + offset.
      ...(a.soundFrom
        ? {
            soundFrom: {
              assetId: a.soundFrom.assetId,
              name: s.assets.find((x) => x.id === a.soundFrom!.assetId)?.name ?? null,
              offset: Math.round(a.soundFrom.offset * 1000) / 1000,
            },
          }
        : {}),
      // What the file's code values mean, for footage that is not plain
      // Rec.709: the profile in force and, when the person overrode it, what
      // the header read (set_source_color changes it).
      ...(sourceProfileOf(a) !== "rec709" || (a.color && a.color.detected !== "rec709")
        ? {
            sourceColor: {
              profile: sourceProfileOf(a),
              ...(a.color && a.colorProfile && a.colorProfile !== a.color.detected ? { detected: a.color.detected } : {}),
            },
          }
        : {}),
      // Source spans whose frame map exists (persisted with the project):
      // distinct-moment times and cut candidates recorded by an earlier watch
      // or by the background sweep. The map aims a watch — it is not seen
      // footage; only sheets returned in this chat are. `watching` marks the
      // sweep still filling the rest; the spans grow as segments land.
      ...(a.watch && a.watch.ranges.length > 0
        ? { mapped: a.watch.ranges.map((rg) => ({ from: roundT(rg.from), to: roundT(rg.to) })) }
        : {}),
      ...(live && watchSweepActive(a.id) ? { watching: true } : {}),
      // The written record of this source — what someone looked at these
      // frames and wrote down (note_source). Unlike `mapped`, this IS seen
      // footage, and it survives the contact sheets that showed it, so a
      // source too long to hold in one conversation is decided from here.
      // The snapshot rides every model call, so it carries the notes while
      // they are small and hands the rest to get_state.
      ...noteFields(a.watch?.notes, opts.fullCues),
      // The source's own transcript (built quietly by the sweep; no subtitle
      // track involved). The snapshot carries the verdict; get_state carries
      // the segments — read those for the words instead of inlining audio.
      ...(a.speech
        ? {
            speech: a.speech.noSpeech ? "none" : "transcribed",
            ...(opts.fullCues && a.speech.segments.length > 0
              ? {
                  transcript: a.speech.segments.map((sg) => ({
                    start: roundT(sg.start),
                    end: roundT(sg.end),
                    text: sg.text,
                  })),
                }
              : {}),
          }
        : {}),
    })),
    mediaTruncated: shownAssets.length < visibleAssets.length,
    ...(live && otherChatsMedia > 0 ? { mediaInOtherChats: otherChatsMedia, mediaInOtherChatsNote: OTHER_CHATS_MEDIA_NOTE } : {}),
    videoTrack: spans.map((sp, index) => ({
      index,
      id: sp.clip.id,
      ...(sp.clip.groupId ? { groupId: sp.clip.groupId } : {}),
      asset: sp.asset.name,
      ...(sp.clip.name ? { name: sp.clip.name } : {}),
      start: roundT(sp.start),
      len: roundT(sp.len),
      in: roundT(sp.clip.in),
      out: roundT(sp.clip.out),
      // A still has no source length; report its placed length instead of 0.
      sourceDuration: roundT(sp.asset.type === "image" ? sp.len : sp.asset.duration),
      // A blocked-out shot holds a slot and draws a flat colour — there is no
      // picture here yet, and its label lives on the chip. Without this the
      // label reads as a clip's name and a shell of a cut looks finished.
      ...(sp.asset.block ? { emptyShot: true } : {}),
      muted: sp.clip.muted,
      ...(sp.clip.hidden ? { hidden: true } : {}),
      // The clip's own equalizer/compressor/limiter, set through
      // set_clip_sound; absent when its sound is untouched.
      ...(sp.clip.sound ? { sound: sp.clip.sound } : {}),
      ...splitEditOf(sp.clip),
      framing: sp.clip.fit ?? "fit",
      ...describeRate(sp.clip),
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
        return sp.start - prevEnd > 0.005 ? { gapBefore: roundT(sp.start - prevEnd) } : {};
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
      ...(sp.clip.flipH ? { flipH: true } : {}),
      ...(sp.clip.flipV ? { flipV: true } : {}),
      ...(sp.clip.rotation ? { rotation: sp.clip.rotation } : {}),
      ...((sp.clip.opacity ?? 1) < 1 ? { opacity: r(sp.clip.opacity ?? 1) } : {}),
      ...(sp.clip.grade ? { colorGrade: sp.clip.grade } : {}),
      ...(sp.clip.mask ? { mask: sp.clip.mask } : {}),
      ...(sp.clip.kf?.length
        ? { keyframes: sp.clip.kf.map((k) => ({ ...k, t: roundT(k.t), x: rF(k.x), y: rF(k.y) })) }
        : {}),
      ...(sp.clip.motionBlur ? { motionBlur: r(sp.clip.motionBlur) } : {}),
      ...clipEffects(sp.clip, live, { aspect: s.aspect, assetById }),
    })),
    // Video layers composited over track 0 in track order (the topmost
    // full-frame clip covers the rest). Each track carries its own
    // transitions, reported per clip like track 0's.
    overlayVideo: [...new Set(overlayLayers(s.clips).map((c) => c.track))].flatMap((track) => {
      const trackSpans = getClipSpans(s.clips, s.assets, track);
      return trackSpans.map((sp, i) => ({
        id: sp.clip.id,
        ...(sp.clip.groupId ? { groupId: sp.clip.groupId } : {}),
        ...describeOverlayClip(sp.clip, assetById),
        ...(() => {
          const t = transitionToNext(sp, i, trackSpans);
          return t ? { transitionToNext: t } : {};
        })(),
        ...clipEffects(sp.clip, live, { aspect: s.aspect, assetById }),
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
            ...(t.groupId ? { groupId: t.groupId } : {}),
            start: roundT(t.start),
            seconds: roundT(t.seconds),
            style: t.style,
            ...(t.feather ? { feather: t.feather } : {}),
            ...(t.band ? { band: t.band } : {}),
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
    // Each group's camera once, keys in seconds from the group's start
    // (set_group_camera); the members carry only their groupId.
    ...(() => {
      const cams = groupCameras(s.overlays);
      return cams.length
        ? {
            groupCameras: cams.map((c) => ({
              groupId: c.groupId,
              start: roundT(c.start),
              keys: c.keys.map((k) => ({ ...k, t: roundT(k.t), x: rF(k.x), y: rF(k.y), scale: r(k.scale), rotation: r(k.rotation) })),
              ...(c.motionBlur ? { motionBlur: r(c.motionBlur) } : {}),
            })),
          }
        : {};
    })(),
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
      // The look the captions wear, so a reference's caption treatment is
      // legible without the cues: style preset, font, size, anchor, and the
      // word effect.
      ...(s.subtitles.style ? { style: s.subtitles.style } : {}),
      ...(s.subtitles.font ? { font: s.subtitles.font } : {}),
      ...(s.subtitles.size !== undefined ? { size: s.subtitles.size } : {}),
      ...(s.subtitles.x !== undefined || s.subtitles.y !== undefined
        ? { x: rF(s.subtitles.x ?? 0.5), y: rF(s.subtitles.y ?? 0.5) }
        : {}),
      ...(s.subtitles.wordHighlight ? { wordHighlight: true } : {}),
      ...(s.subtitles.accentMode ? { accentMode: s.subtitles.accentMode } : {}),
      ...(s.subtitles.accentColor ? { accentColor: s.subtitles.accentColor } : {}),
      // The emphasis style, where it departs from the default
      // (set_caption_look emphasis_*); the words wearing it ride on each cue.
      ...(s.subtitles.emphasisFont ? { emphasisFont: s.subtitles.emphasisFont } : {}),
      ...(s.subtitles.emphasisColor ? { emphasisColor: s.subtitles.emphasisColor } : {}),
      ...(s.subtitles.emphasisItalic !== undefined ? { emphasisItalic: s.subtitles.emphasisItalic } : {}),
      ...(s.subtitles.emphasisWeight !== undefined ? { emphasisWeight: s.subtitles.emphasisWeight } : {}),
      ...(s.subtitles.emphasisScale !== undefined ? { emphasisScale: s.subtitles.emphasisScale } : {}),
      status: s.subtitleStatus,
      // A window of cues by default; when truncated the model calls get_state
      // for the whole transcript (e.g. "clean up all the captions").
      cues: s.subtitles.cues.slice(0, cueCap).map((c) => ({
        id: c.id,
        ...(c.groupId ? { groupId: c.groupId } : {}),
        start: roundT(c.start),
        end: roundT(c.end),
        text: c.text,
        ...(subtitleTracks > 1 ? { track: c.lane ?? 0 } : {}),
        ...cueExtras(c),
      })),
      cuesTruncated: s.subtitles.cues.length > cueCap,
    },
  };
}

/** What a cue carries beyond its words and times: its emphasized words as
 * [index, word] pairs (set_caption_emphasis), and its own x/y when it sits
 * apart from its track (update_cue). Absent when it has neither. */
function cueExtras(c: SubtitleCue) {
  const emphasis = emphasizedWords(c);
  return {
    ...(emphasis.length > 0 ? { emphasis } : {}),
    ...(c.x !== undefined && c.y !== undefined ? { x: rF(c.x), y: rF(c.y) } : {}),
  };
}

/** A clip's rate as the model reads it: one number, or the average plus the
 * curve's nodes as [sourceSeconds, rate] when the rate changes through the
 * footage. */
function describeRate(c: { speed?: number; speedCurve?: SpeedNode[]; reverse?: boolean; smoothSlow?: boolean; in: number; out: number }) {
  const nodes = speedCurveOf(c);
  const reverse = { ...(c.reverse ? { reverse: true } : {}), ...(c.smoothSlow ? { smooth: true } : {}) };
  if (!nodes) return { speed: r(c.speed ?? 1), ...reverse };
  return {
    speed: r(retimeOf(c).rate),
    speedCurve: nodes.map(([at, rate]) => [r(at), r(rate)]),
    ...reverse,
  };
}

function describeAudio(
  a: { groupId?: string; assetId: string; name?: string; start: number; in: number; out: number; volume: number; fadeIn?: number; fadeOut?: number; speed?: number; speedCurve?: SpeedNode[]; reverse?: boolean; sound?: ClipSound; duck?: number; lane?: number; hidden?: boolean },
  assets: Map<string, { name: string }>
) {
  const rt = retimeOf(a);
  const speed = rt.rate;
  return {
    ...(a.groupId ? { groupId: a.groupId } : {}),
    asset: assets.get(a.assetId)?.name ?? a.assetId,
    ...(a.name ? { name: a.name } : {}),
    start: roundT(a.start),
    len: roundT(rt.len),
    in: roundT(a.in),
    out: roundT(a.out),
    volume: r(a.volume),
    fadeIn: r(a.fadeIn ?? 0),
    fadeOut: r(a.fadeOut ?? 0),
    ...(a.sound ? { sound: a.sound } : {}),
    ...(speed !== 1 || a.speedCurve || a.reverse ? describeRate(a) : {}),
    ...(a.lane ? { lane: a.lane } : {}),
    ...(a.hidden ? { hidden: true } : {}),
    // A voiceover: while it plays, other audio ducks to this gain.
    ...(a.duck !== undefined ? { duck: r(a.duck) } : {}),
  };
}

/** A clip's split edit as set_split_edit wrote it: seconds its sound leads
 * the picture and carries past it. Absent when it has none. */
function splitEditOf(c: VideoClip) {
  return c.audioLead || c.audioTail ? { audioLead: c.audioLead ?? 0, audioTail: c.audioTail ?? 0 } : {};
}

function describeOverlayClip(c: VideoClip, assets: Map<string, { name: string }>) {
  const rect = rectOf(c);
  return {
    asset: assets.get(c.assetId)?.name ?? c.assetId,
    ...(c.name ? { name: c.name } : {}),
    track: c.track,
    start: roundT(c.start),
    len: roundT(retimeOf(c).len),
    in: roundT(c.in),
    out: roundT(c.out),
    muted: c.muted,
    ...splitEditOf(c),
    ...(c.hidden ? { hidden: true } : {}),
    ...(c.sound ? { sound: c.sound } : {}),
    // The frame region this layer occupies: Full covers the frame; Top/Bottom/
    // Left/Right split it; PiP floats inside it.
    layout: regionLabel(rect),
    region: { x: rF(rect.x), y: rF(rect.y), w: rF(rect.w), h: rF(rect.h) },
    fit: c.fit ?? "fit",
    ...(clipZoom(c) > 1
      ? { zoom: r(clipZoom(c)), panX: r(c.panX ?? 0), panY: r(c.panY ?? 0) }
      : c.fit === "fill"
        ? { panX: r(c.panX ?? 0), panY: r(c.panY ?? 0) }
        : {}),
    ...(c.flipH ? { flipH: true } : {}),
    ...(c.flipV ? { flipV: true } : {}),
    ...(c.rotation ? { rotation: c.rotation } : {}),
    ...((c.opacity ?? 1) < 1 ? { opacity: r(c.opacity ?? 1) } : {}),
    ...(retimeOf(c).rate !== 1 || c.speedCurve || c.reverse || c.smoothSlow ? describeRate(c) : {}),
    ...(c.grade ? { colorGrade: c.grade } : {}),
    ...(c.mask ? { mask: c.mask } : {}),
    ...(c.boxStyle ? { boxStyle: c.boxStyle } : {}),
    ...(c.kf?.length
      ? { keyframes: c.kf.map((k) => ({ ...k, t: roundT(k.t), x: rF(k.x), y: rF(k.y) })) }
      : {}),
    ...(c.motionBlur ? { motionBlur: r(c.motionBlur) } : {}),
  };
}

function describeOverlay(o: Overlay) {
  const base = {
    kind: o.kind ?? "text",
    ...(o.groupId ? { groupId: o.groupId } : {}),
    name: overlayName(o),
    start: roundT(o.start),
    end: roundT(o.end),
    x: rF(o.x),
    y: rF(o.y),
    ...(o.rotation ? { rotation: o.rotation } : {}),
    ...(o.opacity !== undefined ? { opacity: r(o.opacity) } : {}),
    ...(o.blur ? { blur: r(o.blur) } : {}),
    ...(o.motionBlur ? { motionBlur: r(o.motionBlur) } : {}),
    ...(hasOverlayAnim(o.anim) ? { anim: o.anim } : {}),
    ...(o.kf?.length
      ? { keyframes: o.kf.map((k) => ({ ...k, t: roundT(k.t), x: rF(k.x), y: rF(k.y) })) }
      : {}),
    ...(o.mask ? { mask: o.mask } : {}),
    ...(o.lane ? { lane: o.lane } : {}),
    ...(o.hidden ? { hidden: true } : {}),
  };
  if (o.kind === "shape") {
    return {
      ...base,
      shape: o.shape,
      w: rF(o.w),
      h: rF(o.h),
      fill: o.fill,
      ...(o.fillOpacity !== undefined ? { fillOpacity: r(o.fillOpacity) } : {}),
      ...(o.radius ? { radius: o.radius } : {}),
      ...(o.stroke ? { stroke: o.stroke } : {}),
      ...(o.pattern ? { pattern: o.pattern } : {}),
      ...(o.shadow ? { shadow: o.shadow } : {}),
    };
  }
  if (o.kind === "sticker") {
    return { ...base, assetId: o.assetId, w: rF(o.w), ...(o.h ? { h: rF(o.h) } : {}) };
  }
  if (o.kind === "effect") {
    return {
      ...base,
      effect: o.effect,
      amount: r(o.amount ?? 0.5),
      ...(o.effect === "zoom"
        ? { focus: { x: r(o.focus?.x ?? 0.5), y: r(o.focus?.y ?? 0.5) } }
        : {}),
      ...(o.effect === "lightleak" && o.leak ? { leak: o.leak } : {}),
      ...(o.effect === "glitch" && o.glitch ? { glitch: o.glitch } : {}),
      ...(o.effect === "flash" && o.tone ? { tone: o.tone } : {}),
      ...(o.effect === "flash" && o.rate ? { rate: r(o.rate), rhythm: o.rhythm ?? "strobe" } : {}),
      ...(o.effect === "negative" && o.rate ? { rate: r(o.rate) } : {}),
      ...(o.effect === "flash" && o.fade ? { fade: o.fade, ...(o.fadeEase ? { fade_ease: o.fadeEase } : {}) } : {}),
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
    ...(o.plateRadius !== undefined && { plateRadius: r(o.plateRadius) }),
    ...(o.wrapWidth !== undefined ? { wrapWidth: r(o.wrapWidth) } : {}),
    ...(o.texture ? { texture: o.texture } : {}),
  };
}
