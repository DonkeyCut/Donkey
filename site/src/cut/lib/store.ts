"use client";

import {
  groupRemap,
  isAudioEffect,
  KEY_EPSILON,
  keyAt,
  lineLikeShape,
  maskKeyAt,
  removeKeyAt,
  upsertKey,
  type EffectId,
  type MaskKey,
  type OverlayKey,
} from "@donkeycut/effects-kit";
import { create } from "zustand";
import type {
  Aspect,
  AudioClip,
  ClipAnim,
  ClipSpan,
  LibraryTemplate,
  MediaAsset,
  Overlay,
  OverlayKind,
  OverlayPatch,
  ProjectDoc,
  RenderRecord,
  Selection,
  ShapeKind,
  ShareFeatures,
  StoredAsset,
  SubtitleCue,
  SubtitlesBlock,
  SubtitleTrackMeta,
  TemplateAudio,
  TemplateLayer,
  TemplateMedia,
  TemplateSaveInput,
  TimelineTransition,
  TransitionStyle,
  VideoClip,
} from "./types";
import type { VideoProject } from "./genvideo/types";
import { fillSlot } from "./genvideo/fillSlot";
import { apiFetch, apiJson, getBackend, hasLocalCompute } from "./backend";
import { fetchSignedMediaUrls, pinDocBase } from "./backend/cloud";
import { cancelRevoke, resolveRegisteredBlob, revokeRegistered } from "./backend/browser/registry";
import { markSignedBatch } from "./mediaLinks";
import { dropLocalMedia, localMediaUrl, prefetchCloudMedia } from "./mediaSync";
import {
  dropCachedDoc,
  readCachedDoc,
  readCachedMediaLinks,
  writeCachedDoc,
  writeCachedMediaLinks,
} from "./docCache";
import { renderMix, transcribeSamples, type CloudTranscribeSpec } from "./cloudTranscribe";
import { alignCues } from "./cueAlign";
import { useGenNotify } from "./genNotify";
import { clampPlayhead, playheadAt, previewAt, setPlayhead, setSkim } from "./playhead";
import { engineTranscribeSamples, withEngineStt } from "./localStt";
import { trackLocale } from "./subtitles";
import { ANIM_STYLE_IDS, animStyleOfTransition, clipPoseAt, DEFAULT_BACKGROUND, emptySubtitles, frameOf, IMAGE_CLIP_SECONDS, isAudioTransition, isEffectOverlay, isStickerOverlay, MAX_SUBTITLE_LANES, mediaUrl, migrateBehindSubject, migrateLegacyTransitions, normalizeAspect, overlayAnimStyle, projectBackground, SPEED_FLOOR, SPEED_MIN, stampOverlayKinds, stripDefaultOverlayKinds, TRANSITION_MAX, TRANSITION_STYLE_IDS, transitionStyleOfAnim } from "./types";
import { liftMoveTracks } from "./textMotion";
import { readTextStyle } from "./textStyle";
import { loadUiState, saveUiState, type ProjectUiState } from "./uiState";
import { captureTimelineFrames } from "./visualFrames";

const uid = () => crypto.randomUUID().slice(0, 8);

/** How a clip meets its box, for a template to remember. */
const framingOf = (c: VideoClip) => ({
  ...(c.frame ? { frame: c.frame } : {}),
  ...(c.fit ? { fit: c.fit } : {}),
  ...(c.zoom && c.zoom > 1 ? { zoom: c.zoom } : {}),
  ...(c.panX ? { panX: c.panX } : {}),
  ...(c.panY ? { panY: c.panY } : {}),
  ...(c.rotation ? { rotation: c.rotation } : {}),
  ...((c.opacity ?? 1) < 1 ? { opacity: c.opacity } : {}),
});

/** The same framing, back on a clip a template stands up. */
const templateFraming = (l: TemplateLayer) => ({
  ...(l.frame ? { frame: l.frame } : {}),
  ...(l.fit ? { fit: l.fit } : {}),
  ...(l.zoom && l.zoom > 1 ? { zoom: l.zoom } : {}),
  ...(l.panX ? { panX: l.panX } : {}),
  ...(l.panY ? { panY: l.panY } : {}),
  ...(l.rotation ? { rotation: l.rotation } : {}),
  ...((l.opacity ?? 1) < 1 ? { opacity: l.opacity } : {}),
});

const MIN_LEN = 0.1;

/** Where a video clip lands when dropped: an existing track or a brand-new
 * track inserted at z-level `level`. Tracks number 0..N bottom-up: track 0 is
 * the bottom row, higher tracks composite in front. Inserting shifts the
 * tracks at/above `level` up to open the slot — inserting at 0 opens a new
 * bottom row, which becomes the spine (ripple, transitions, playback master). */
export type VideoTrackPlacement =
  | { kind: "track"; track: number }
  | { kind: "insert"; level: number };

/** The track-0 clips — the sequence that drives playback and ripple. */
export const track0Clips = (clips: VideoClip[]) => clips.filter((c) => c.track === 0);
/** Every video clip not on track 0 — the composited layers. */
export const overlayLayers = (clips: VideoClip[]) => clips.filter((c) => c.track !== 0);

/** Ground a clip stack: the lowest occupied row becomes track 0. Deleting or
 * dragging away the last track-0 clip re-grounds the rows above it, so the
 * spine — the sequence that carries transitions, fades, and ripple — always
 * exists while any clip does. */
export function groundTracks(clips: VideoClip[]): VideoClip[] {
  const lift = clips.length ? Math.min(...clips.map((c) => c.track)) : 0;
  return lift > 0 ? clips.map((c) => ({ ...c, track: c.track - lift })) : clips;
}

/** Open a slot at `level`, shifting the tracks at/above it up by one. `exclude`
 * is the clip being placed (left untouched). Level 0 shifts the whole stack up:
 * the placed clip becomes the new track 0 — the spine transplants to it. */
function openInsertSlot(clips: VideoClip[], level: number, exclude?: string): VideoClip[] {
  return clips.map((c) =>
    c.id !== exclude && c.track >= level ? { ...c, track: c.track + 1 } : c
  );
}
const shiftTracksUp = (clips: VideoClip[], place: VideoTrackPlacement): VideoClip[] =>
  place.kind === "insert" ? openInsertSlot(clips, place.level) : clips;

/** The renumbering a row move produces: the row at index `from` lifts out of
 * `used` and drops at `to`, and the result maps every old row key to its new
 * index. Null when the move is a no-op or points off the end, so callers can
 * skip the undo step entirely. */
function rowRenumber(used: number[], from: number, to: number): Map<number, number> | null {
  if (from === to || from < 0 || to < 0 || from >= used.length || to >= used.length) return null;
  const next = [...used];
  next.splice(to, 0, next.splice(from, 1)[0]);
  return new Map(next.map((row, i) => [row, i]));
}

/** A single-item selection: the primary that drives the Inspector plus the
 * one-element multiSelection that bulk actions (delete, copy) and the timeline
 * highlight read. Every mutation that selects its own result funnels through
 * this so the two can never drift apart. */
const sole = (sel: NonNullable<Selection>) => ({ selection: sel, multiSelection: [sel] });

/** Where a `len`-long clip aimed at `place`/`start` lands: the resolved track,
 * the landing start, and the ripple shifts it pushes onto that row. An
 * existing track has residents — insert at the pointer and ripple that
 * track's later clips right. An inserted track is brand-new, so the start
 * holds as-is. `exclude` is the clip being moved (left out of the ripple). */
function landOnPlacement(
  clips: VideoClip[],
  place: VideoTrackPlacement,
  start: number,
  len: number,
  exclude?: string
): { track: number; start: number; shifts: { id: string; start: number }[] } {
  const track = place.kind === "insert" ? place.level : place.track;
  const landing =
    place.kind === "track"
      ? rippleInsert(
          clips.filter((c) => c.track === track && c.id !== exclude),
          Math.max(0, start),
          len
        )
      : { start: Math.max(0, start), shifts: [] as { id: string; start: number }[] };
  return { track, ...landing };
}

/** The state patch every placement commits: clips sorted by start, transitions
 * re-anchored to the cuts they sat on, and the placed clip selected. */
function placedState(
  s: { clips: VideoClip[]; transitions: TimelineTransition[] },
  next: VideoClip[],
  id: string
) {
  const clips = [...next].sort((a, b) => a.start - b.start);
  return {
    clips,
    transitions: reanchorTransitions(s.clips, clips, s.transitions),
    ...sole({ kind: "clip", id }),
  };
}

export const TIMELINE_H_DEFAULT = 272;
export const TIMELINE_H_MIN = 194;
/**
 * Timeline zoom bounds, in px per second of media. The low end is a sanity
 * floor only: how far out a project may zoom depends on how wide the timeline
 * is on screen, which the store cannot see, so the real floor is the
 * viewport-aware one the timeline computes (`zoomFloor`). A long project needs
 * to reach well under a px/s for its whole strip to fit, so anything higher
 * here silently overrides that and puts the end of the project out of reach.
 */
export const PPS_MIN = 0.01;
export const PPS_MAX = 800;
const clampPps = (v: number) =>
  Number.isFinite(v) ? Math.max(PPS_MIN, Math.min(PPS_MAX, v)) : 60;
/** Tallest the timeline may grow: the window height less room for the top bar
 * and a usable preview. The constant covers code running without a window. */
export const timelineHMax = () =>
  typeof window === "undefined" ? 600 : Math.max(TIMELINE_H_MIN, window.innerHeight - 220);

interface DocSnapshot {
  clips: VideoClip[];
  transitions: TimelineTransition[];
  audioClips: AudioClip[];
  overlays: Overlay[];
  subtitles: SubtitlesBlock;
}

export type SubtitleStatus = "idle" | "running" | "ready" | "empty" | "error";

export type SaveState = "saved" | "dirty" | "saving" | "error";

export interface EditorState {
  projectId: string | null;
  projectName: string;
  loaded: boolean;
  /** Bumped every time a document is hydrated into the store — the cached
   * copy an open paints first, the live one that replaces it, a conflict
   * reload. Autosave watches it to re-baseline, so a document that arrived
   * from the server is never saved straight back to it. */
  loadEpoch: number;
  loadError: string | null;
  saveState: SaveState;
  /** Raised when an open resumed unsaved edits from the dirty disk snapshot:
   * autosave sees it, clears it, and pushes the resumed document up. */
  resumePush: boolean;
  /** Read-only shared view: the set wrapper strips doc-mutating writes, so
   * every edit path is inert by construction. View state stays live. */
  readOnly: boolean;
  /** The share's opted-in surfaces; null outside a shared view. */
  sharedFeatures: ShareFeatures | null;

  assets: MediaAsset[];
  /** Media files still streaming into the browser store, by fileName.
   * Timeline items on these show a loading chip and hold their hover
   * controls until the local bytes land — or the prefetch gives up and
   * signed URLs carry the file. */
  loadingMedia: Set<string>;
  /** Every video clip, on any track. Tracks number 0..N bottom-up: track 0
   * carries the transition sequence, higher tracks composite in front. A
   * clip's `track` field is the only thing that places it. */
  clips: VideoClip[];
  /** Transition bars: free objects on the transitions row, owned by no clip.
   * A bar plays when it lines up with a cut or an open edge (resolveTransitions)
   * and sits inert anywhere else; the per-clip transition/anim fields are
   * caches derived from these in the set wrapper. */
  transitions: TimelineTransition[];
  audioClips: AudioClip[];
  overlays: Overlay[];
  /** Output frame ratio ("W:H", short side 1080), persisted per project. */
  aspect: Aspect;
  /** The aspect was chosen deliberately (picker, set_aspect, or saved in the
   * doc) — the first-import orientation guess stands down. Not a doc field. */
  aspectTouched: boolean;
  /** Whole-video fades, seconds (0 = off): in from black at the start, out to
   * black at the end of the cut. Applied to the final picture and mix. */
  fadeIn: number;
  fadeOut: number;
  /** The frame's own color, behind every clip and element. A cut made of
   * nothing but titles and shapes plays over it, a fitted clip letterboxes
   * into it, and a gap on track 0 shows it. */
  background: string;
  selection: Selection;
  /** Everything selected, including `selection` (the primary that drives the
   * inspector). Bulk actions — delete, copy — act on this whole set. */
  multiSelection: Selection[];
  /** The keyframe picked on a timeline bar — an element's or a video
   * clip's, on its pose track or its mask's — if any. It rides alongside
   * the item selection: the item is still what the inspector edits, but
   * Delete takes the key. Any other selection clears it. */
  selectedKey: {
    kind: "overlay" | "clip";
    id: string;
    t: number;
    track: "pose" | "mask";
  } | null;
  playing: boolean;
  /** While playing a scoped effect preview, the time playback auto-pauses at;
   * null otherwise. Manual seek/play/pause clears it. */
  previewStopAt: number | null;
  pxPerSec: number;
  /** Timeline panel height in px (drag the panel's top border to change). */
  timelineH: number;
  /** TikTok publishing metadata (caption, hashtags, sound title). */
  publish: { caption: string; tags: string; soundTitle: string; handle: string };
  /** Free-form maker notes: published date, source links, reminders. */
  notes: { text: string; publishedAt: string; links: string[] };
  /** Subtitles: cues + visibility, persisted with the project. */
  subtitles: SubtitlesBlock;
  subtitleStatus: SubtitleStatus;
  subtitleError: string | null;
  /** Epoch ms when the running transcription/translation started — the panel
   * shows a ticking elapsed beside its spinner. */
  subtitleStartedAt: number | null;
  exportOpen: boolean;
  /** OS file drag in flight: "media" when it carries video/audio/image (so the
   * timeline is a valid target), "other" for text-only drags, null when idle. */
  dropActive: "media" | "other" | null;
  /** Whether the AI assistant panel is open (remembered across sessions). */
  aiOpen: boolean;
  /** In-progress or finished brief-to-video run; persisted on ProjectDoc.genvideo
   * and driven by the genScene store. Absent when no scene was generated. */
  genvideo?: VideoProject;
  /** Chat-launched renders mirrored from the job store (ProjectDoc.renders),
   * so their chat cards render on machines that never ran the job. Outside the
   * undo history, like assets. */
  renders: RenderRecord[];
  /** The doc's first-open presentation (ProjectDoc.firstOpen), carried so the
   * editor can apply it and saves keep it. */
  firstOpen?: ProjectDoc["firstOpen"];

  /** Load a project into the store. `inPlace` is for re-reading a project the
   * editor is already showing (the viewer's change poll, a conflict reload):
   * the stored copy has moved on, so the head-start snapshot is skipped and
   * only the live document is applied. */
  loadProject: (id: string, opts?: { inPlace?: boolean }) => Promise<void>;
  /** Apply one project document to the store: the legacy migrations and the
   * state swap, shared by every hydration path — the snapshot paint, the live
   * load, a conflict reload, and a headless open. */
  applyDocState: (doc: Partial<ProjectDoc>, assets: MediaAsset[], ui: ProjectUiState) => void;
  /** Open a project from an already-fetched document. The headless runner's
   * open: resets the store, drains pending doc writes, and hydrates straight
   * from the given document. */
  openProjectDoc: (id: string, doc: Partial<ProjectDoc>, assets: MediaAsset[]) => Promise<void>;
  setProjectName: (name: string) => void;
  setSaveState: (s: SaveState) => void;
  /** Enter read-only shared mode; call before loadProject. */
  setSharedView: (features: ShareFeatures) => void;

  setAspect: (a: Aspect) => void;
  /** Set the whole-video fade in/out (seconds; 0 clears). Like the aspect,
   * project-level settings sit outside the undo history. */
  setProjectFade: (patch: { fadeIn?: number; fadeOut?: number }) => void;
  /** Set the frame color. Project-level, so it sits outside undo like the
   * aspect and the fades. */
  setBackground: (hex: string) => void;
  addAsset: (asset: MediaAsset) => void;
  updateAsset: (id: string, patch: Partial<MediaAsset>) => void;
  /** Swap asset URLs in place (fileName -> url), e.g. after re-minting an
   * expired signed batch. Runtime-only — the stored projection omits url —
   * and allowed in read-only shared views. */
  applyMediaUrls: (urls: Map<string, string>) => void;
  /** Remove a project asset and any clips/audio that reference it. */
  removeAsset: (id: string) => void;
  /** Add a video clip from an asset onto video track 0 — at `start` (sliding
   * to the track's next free slot), or appended at the end when omitted. */
  addClipFromAsset: (assetId: string, start?: number) => void;
  /** Add a soundtrack clip from an audio asset at `start` (default: the
   * playhead). `opts.duck` marks it a voiceover that lowers everything else
   * to that gain while it plays; `opts.lane` picks the audio track it lands
   * on (default: the first one). */
  addAudioFromAsset: (assetId: string, start?: number, opts?: { duck?: number; lane?: number }) => void;
  /** The panel “+” add: the asset lands at the preview time (the skimmer while
   * one is live, the playhead otherwise), on the lowest video track or audio
   * lane with room for its whole length there. When every existing row is
   * occupied at that moment it opens a new row above. */
  addAssetAtPlayhead: (assetId: string) => void;
  /** Set (or clear) the persisted brief-to-video run. Replaces the object by
   * reference so autosave detects the change. */
  setGenvideo: (project: VideoProject | undefined) => void;
  /** Brief-to-video placement: place a generated clip filling a [startSec,
   * endSec)-sized slot on track 0 — muted, time-stretched or trimmed to the
   * slot — and return its id. Where it lands goes through `placeInRun`:
   * anchored after the run's earlier clips, never past its later ones, slid
   * clear of everything else. Leaves selection untouched (the run is a
   * background process). */
  placeGenClip: (assetId: string, startSec: number, endSec: number, opts?: { srcInSec?: number; muted?: boolean; anchorAfterIds?: string[]; followClipIds?: string[] }) => string | null;
  /** Brief-to-video placement: place a generated audio clip at the next free
   * slot at/after startSec on its soundtrack lane, spanning up to durSec
   * (duck/lane/volume optional), returning its id. */
  placeGenAudio: (assetId: string, startSec: number, durSec: number, opts?: { duck?: number; lane?: number; volume?: number }) => string | null;
  /** Remove a video clip by id (a background gen swap; leaves its slot empty). */
  removeClipById: (id: string) => void;
  /** Remove a soundtrack clip by id (background gen swap, idempotent placement). */
  removeAudioById: (id: string) => void;
  /** Re-mark a resumed run's already-placed clips as render-owned. The gen sets
   * reset on load, so hydrate re-registers the persisted plan's clip ids to keep
   * undo/redo off them while the run finishes. */
  adoptGenClips: (clipIds: string[], audioIds: string[]) => void;
  /** Hand a finished run's clips over to the user's undo domain: splice them
   * into every existing history snapshot (which excluded them while the run
   * owned them) and clear the gen sets, so post-run edits to generated clips
   * undo like any other edit. */
  releaseGenClips: () => void;
  /** Place a title element; a drop (or the assistant) passes where it landed. */
  addOverlay: (aim?: { at?: number; lane?: number }) => void;
  /** Add a vector shape element on the title lanes at the playhead. */
  /** Place a shape element; a drop passes where it landed. */
  addShape: (shape: ShapeKind, aim?: { at?: number; lane?: number }) => void;
  /** Add a sticker element (a project image asset, a Lottie animation, or an
   * image asset) on the title lanes at the playhead. */
  /** Place a sticker element. A drop passes `at`/`lane` to land where it was
   * released; without them it goes to the playhead on the home row. */
  addSticker: (init: { assetId: string; lottie?: boolean; at?: number; lane?: number }) => void;
  /** Add a time-ranged visual effect element at the playhead. */
  /** Place an effect element; a drop passes where it landed. */
  addEffect: (effect: EffectId, aim?: { at?: number; lane?: number }) => void;
  updateClip: (id: string, patch: Partial<VideoClip>) => void;
  /** Set a clip's playback rate (0.25–4). A longer footprint pushes the
   * following clips right by the overflow; a shorter one opens a gap. */
  setClipSpeed: (id: string, speed: number) => void;
  /** Set a clip's source trim points with the same run rules as a speed
   * resize: a longer footprint pushes the following clips right, a shorter
   * one opens a gap, and a live dissolve keeps its overlap. */
  setClipTrim: (id: string, nextIn: number, nextOut: number) => void;
  /** Set the transition into the next clip (seconds; 0 clears it), optionally
   * changing its style; omitting the style keeps the current one. Upserts the
   * bar playing the clip's tail — the clip fields follow by derivation. */
  setClipTransition: (id: string, seconds: number, style?: TransitionStyle) => void;
  /** Set (or clear with null) a clip's own entrance/exit animation. Upserts
   * the bar on that edge; never moves the layout. */
  setClipAnim: (id: string, which: "in" | "out", anim: ClipAnim | null) => void;
  /** Put a new transition bar on the row, wherever `start` says. Returns its
   * id. It plays only where it lines up with a cut or an open edge. */
  addTransition: (bar: { start: number; seconds: number; style: TransitionStyle }) => string;
  /** Move, retime or restyle a bar (one undo entry). */
  updateTransition: (id: string, patch: Partial<Omit<TimelineTransition, "id">>) => void;
  /** The same, with no undo checkpoint — for mid-gesture updates. */
  updateTransitionTransient: (id: string, patch: Partial<Omit<TimelineTransition, "id">>) => void;
  removeTransition: (id: string) => void;
  /** Carry the bars through a retime the caller just wrote: given the clip row
   * as it stood before, every bar keeps playing the boundary it played, at
   * wherever that boundary moved to. No undo checkpoint — the caller's own
   * push covers the whole edit. For the retiming paths outside this store. */
  reanchorBars: (before: VideoClip[]) => void;
  /** Set (or clear with null) a clip's preset filter look; amount 0..1. */
  updateAudio: (id: string, patch: Partial<AudioClip>) => void;
  /** Hide or show every clip on one video track, in one undo step. Showing a
   * track also shows its individually hidden clips. */
  setTrackHidden: (track: number, hidden: boolean) => void;
  /** Mute or unmute every clip on one video track, in one undo step. */
  setTrackMuted: (track: number, muted: boolean) => void;
  /** Mute or unmute every segment on one soundtrack lane, in one undo step. */
  setAudioLaneHidden: (lane: number, hidden: boolean) => void;
  /** Hide or show every title on one title lane, in one undo step. */
  setTextLaneHidden: (lane: number, hidden: boolean) => void;
  /** Reorder the occupied video tracks: the track sitting at z-index `from`
   * (0 = the bottom track) lands at `to` and the rest close up around it.
   * Tracks renumber to 0..n-1, so whatever lands at 0 becomes the spine. */
  moveVideoTrack: (from: number, to: number) => void;
  /** Reorder the element rows: the row at display index `from` (0 = the top
   * row) lands at `to`. Lanes renumber to 0..n-1 in the new order. */
  moveOverlayLane: (from: number, to: number) => void;
  /** Reorder the soundtrack lanes the same way, top row first. */
  moveAudioLane: (from: number, to: number) => void;
  updateOverlay: (id: string, patch: OverlayPatch) => void;
  /** Live-drag updates that should not create undo entries. */
  updateOverlayTransient: (id: string, patch: OverlayPatch) => void;
  /** Keyframes. `tLocal` is seconds from the element's start; a key already
   * sitting there is replaced rather than doubled. Adding one captures the
   * element's pose at that moment, so the first key never moves anything.
   * `patch` (position, scale, rotation, opacity) edits the key in place —
   * that is how dragging a keyframed element in the preview records. */
  setOverlayKey: (
    id: string,
    tLocal: number,
    patch?: Partial<Omit<OverlayKey, "t">>,
    opts?: { transient?: boolean }
  ) => void;
  /** Delete one element outright — the clip panel taking an effect back off. */
  removeOverlay: (id: string) => void;
  removeOverlayKey: (id: string, tLocal: number) => void;
  /** Pick a keyframe on the timeline: the element becomes the selection and
   * the key rides along, so Delete removes the key rather than the element. */
  selectOverlayKey: (id: string, tLocal: number) => void;
  /** Retime a key, keeping its pose — dragging one along the timeline bar.
   * Dropped onto another key it replaces that one, same as setting a key
   * where one already sits. */
  moveOverlayKey: (
    id: string,
    fromT: number,
    toT: number,
    opts?: { transient?: boolean }
  ) => void;
  clearOverlayKeys: (id: string) => void;
  /** Mask keyframes, the mask's own track beside the pose track. Same rules:
   * adding a key captures the mask's live geometry, `patch` edits it in
   * place, and a key already sitting at `tLocal` is replaced. */
  setOverlayMaskKey: (
    id: string,
    tLocal: number,
    patch?: Partial<Omit<MaskKey, "t">>,
    opts?: { transient?: boolean }
  ) => void;
  removeOverlayMaskKey: (id: string, tLocal: number) => void;
  selectOverlayMaskKey: (id: string, tLocal: number) => void;
  moveOverlayMaskKey: (
    id: string,
    fromT: number,
    toT: number,
    opts?: { transient?: boolean }
  ) => void;
  clearOverlayMaskKeys: (id: string) => void;
  /** The same mask-key track on a video clip; `tLocal` is seconds from the
   * clip's timeline start. */
  setClipMaskKey: (
    id: string,
    tLocal: number,
    patch?: Partial<Omit<MaskKey, "t">>,
    opts?: { transient?: boolean }
  ) => void;
  removeClipMaskKey: (id: string, tLocal: number) => void;
  selectClipMaskKey: (id: string, tLocal: number) => void;
  moveClipMaskKey: (
    id: string,
    fromT: number,
    toT: number,
    opts?: { transient?: boolean }
  ) => void;
  clearClipMaskKeys: (id: string) => void;
  /** The pose-key track on a video clip, the overlay contract over the
   * clip's anchor: adding a key captures the clip's pose at that moment,
   * `patch` edits it in place, and a key already at `tLocal` is replaced. */
  setClipKey: (
    id: string,
    tLocal: number,
    patch?: Partial<Omit<OverlayKey, "t">>,
    opts?: { transient?: boolean }
  ) => void;
  removeClipKey: (id: string, tLocal: number) => void;
  selectClipKey: (id: string, tLocal: number) => void;
  moveClipKey: (id: string, fromT: number, toT: number, opts?: { transient?: boolean }) => void;
  clearClipKeys: (id: string) => void;
  /** Patch several items in one commit — the lane coordinator's gestures part
   * and push whole lanes at a time (one bulk patcher per lane-track kind). */
  updateOverlaysTransient: (patches: { id: string; patch: OverlayPatch }[]) => void;
  updateAudiosTransient: (patches: { id: string; patch: Partial<AudioClip> }[]) => void;
  updateCuesTransient: (patches: { id: string; patch: Partial<SubtitleCue> }[]) => void;
  updateClipsTransient: (patches: { id: string; patch: Partial<VideoClip> }[]) => void;
  updateClipTransient: (id: string, patch: Partial<VideoClip>) => void;
  updateAudioTransient: (id: string, patch: Partial<AudioClip>) => void;
  /** Keep the clips array sorted by start (consumers read `clips[0]` as the
   * timeline's first clip). Called after a lane-coordinator move commits. */
  sortClips: () => void;
  /** Reorder video track 0 by index (the AI reorder op): the clip lifts out
   * (leaving a gap) and a slot opens at the target index — clips from the
   * landing point shift right; nothing else moves. */
  moveClip: (id: string, toIndex: number) => void;
  /** Add a video asset to the timeline at a placement: an existing track or a
   * freshly inserted one. Used by media / library drops. */
  addVideoFromAsset: (assetId: string, place: VideoTrackPlacement, start: number) => void;
  /** Move an existing clip to a placement, preserving its trim/region/speed.
   * Inserting a track renumbers the ones above it; dropping onto track 0 lands
   * free-positioned at the drop time. Owns its own history. */
  dropVideoClip: (id: string, place: VideoTrackPlacement, start: number) => void;
  /** "Detach Audio": lift the selected clip's sound onto the
   * soundtrack track (and mute the clip) so it can be cut independently. */
  detachAudio: () => void;
  /** Split at the given time, or the playhead when omitted. */
  splitAtPlayhead: (at?: number) => void;
  setPublish: (patch: Partial<{ caption: string; tags: string; soundTitle: string; handle: string }>) => void;
  setNotes: (patch: Partial<{ text: string; publishedAt: string; links: string[] }>) => void;
  /** Kick off (and poll) an on-device transcription of the current cut. */
  generateSubtitles: () => Promise<void>;
  /** The cut's audible mix as mono samples — the audio a caption is measured
   * against. Null when nothing on the timeline makes a sound, or the mix
   * could not be rendered. */
  cutMixSamples: () => Promise<{ samples: Float32Array; sampleRate: number } | null>;
  /** Transcribe one clip's own audio (even when muted) and merge its cues into
   * the subtitles; cues elsewhere on the timeline stay put. Throws a
   * user-facing error on failure. */
  generateClipSubtitles: (clipId: string) => Promise<void>;
  /** Caption the cut from its picture alone (no audio needed): sample frames
   * along the timeline and have the AI write timed narration cues. */
  generateVisualSubtitles: () => Promise<void>;
  /** Transcribe (if needed) then rewrite the cues into social captions in the
   * given style, one-to-one so cue timings are preserved. */
  generateCaptions: (style: "clean" | "hook" | "punchy") => Promise<void>;
  /** Fill the active track by translating another track's cues into the active
   * track's language. Timings copy over; word timings don't survive
   * translation, so the new cues carry none. */
  translateSubtitleTrack: (fromLane: number) => Promise<void>;
  setSubtitlesView: (patch: Partial<Pick<SubtitlesBlock, "showOnVideo" | "showOnTimeline" | "locale" | "style" | "size" | "font" | "x" | "y" | "wordHighlight" | "accentMode" | "accentColor">>) => void;
  /** The subtitle track (row) the panel edits and generation writes to. */
  subtitleLane: number;
  setSubtitleLane: (lane: number) => void;
  /** Add a subtitle track — one language each, capped at MAX_SUBTITLE_LANES —
   * and make it the active one. */
  addSubtitleTrack: (locale?: string) => void;
  /** Remove a subtitle track: drops its cues and shifts higher tracks down. */
  removeSubtitleTrack: (lane: number) => void;
  /** Patch one track's settings (locale, dragged caption anchor). */
  setSubtitleTrackMeta: (lane: number, patch: Partial<SubtitleTrackMeta>) => void;
  /** Commit a cue's edited text (empty text deletes the cue). */
  setCueText: (id: string, text: string) => void;
  /** Split a cue at a character offset — at real word timings when known. */
  splitCue: (id: string, charOffset: number) => void;
  mergeCueIntoPrev: (id: string) => void;
  deleteCue: (id: string) => void;
  updateCueTransient: (id: string, patch: Partial<SubtitleCue>) => void;
  /** Committed single-cue retime: keep the requested window's length, slide
   * right past occupied stretches on the cue's own lane so cues never overlap,
   * and detach the word timings (they described the old window). One undo step. */
  setCueTiming: (id: string, start: number, end: number) => void;
  /** Re-time cues and elements onto windows something else measured — the
   * caption alignment pass, which reads the mix itself. Exact times, ids,
   * text, word timings and lanes all kept, in one undo step, and nothing
   * slides: the caller's windows are already in order and non-overlapping,
   * so a per-item write that shoved its neighbours would undo the alignment
   * it was given. */
  retimeItems: (patch: {
    cues?: { id: string; start: number; end: number; words?: { t0: number; t1: number; w: string }[] }[];
    overlays?: { id: string; start: number; end: number }[];
  }) => void;
  /** Replace one subtitle track's captions wholesale, in timeline seconds —
   * what a lyric sync writes once it knows when every line lands. */
  setLaneCues: (lane: number, cues: { start: number; end: number; text: string; words?: { t0: number; t1: number; w: string }[] }[]) => void;
  /** Re-time listed cues to a generated voiceover: set each cue's [start, end]
   * and spread its words across the new span (the AI voice paces differently
   * from the original recording, so the word highlighter would otherwise drift). */
  retimeCues: (entries: { id: string; start: number; end: number }[]) => void;
  sortCues: () => void;
  /** Delete the current selection. While track 0 is the only video track and
   * some of its footage survives, a track-0 clip delete ripples: the footprint
   * it occupied closes and everything after it — clips, titles, captions,
   * soundtrack — slides left in sync (see exciseRange). With upper video
   * layers present the slide would shear them against track 0, and with track
   * 0 emptied there is nothing left for the close to keep contiguous, so both
   * leave the gap and everything laid over the footage stands; closing it is
   * `removeLaneGap`. Deletes on every other track remove just that item. */
  deleteSelection: () => void;
  /** Close the empty span on `lane` containing `at` — a video track, an audio
   * track, or a title track. Only that row's later items slide left; every
   * other row stays put. No-op when `at` isn't inside a gap. */
  removeLaneGap: (lane: LaneRef, at: number) => void;
  /** Timeline window [start, end) spanned by the current selection, or null if
   * nothing selectable is chosen. */
  selectionRange: () => { start: number; end: number } | null;
  /** Build a by-reference template from the current selection (media + the edit
   * that arranges it, rebased to 0), or null if nothing usable is selected. */
  selectionTemplate: () => TemplateSaveInput | null;
  /** Re-materialize a template into the project at `offset` seconds. `assetIds`
   * maps each `template.media` index to a freshly-added project asset id. */
  insertTemplate: (template: LibraryTemplate, assetIds: string[], offset: number) => void;
  /** Templates saved in this project (shown in the Media panel; persisted on
   * the doc). Their media reference project files by name. */
  templates: LibraryTemplate[];
  addTemplate: (input: TemplateSaveInput) => LibraryTemplate;
  renameTemplate: (id: string, name: string) => void;
  removeTemplate: (id: string) => void;
  /** Append a project asset to a template as one more part at its end. */
  addAssetToTemplate: (templateId: string, assetId: string) => void;
  select: (sel: Selection) => void;
  /** Group the multi-selected overlay elements (≥2): selecting any member
   * selects them all, and move/resize/rotate/timing act on the set. */
  groupSelectedOverlays: () => void;
  /** Dissolve a group; the members stay, ungrouped. */
  ungroupOverlays: (groupId: string) => void;
  /** ⌘/⇧-click: add the item to the selection (or remove it if already in),
   * making it the new primary. */
  toggleSelect: (sel: NonNullable<Selection>) => void;
  /** Marquee sweep: replace the whole selection at once, last item primary. */
  setMultiSelection: (sels: NonNullable<Selection>[]) => void;
  seek: (t: number) => void;
  setPlaying: (p: boolean) => void;
  /** Play just the [start, end] stretch in the preview: seek to `start`,
   * play, and auto-pause at `end`. Effect pickers use it so choosing a
   * transition/animation immediately shows the real footage doing it. */
  previewRange: (start: number, end: number) => void;
  setPxPerSec: (v: number) => void;
  setTimelineH: (h: number) => void;
  setExportOpen: (v: boolean) => void;
  setDropActive: (v: "media" | "other" | null) => void;
  setAiOpen: (v: boolean) => void;
  undo: () => void;
  redo: () => void;
  upsertRender: (r: RenderRecord) => void;
  removeRenders: (ids: string[]) => void;
  pushHistory: () => void;
  /** Coalesce every edit until the matching `endHistoryBatch` into one undo
   * step. Used so a whole assistant turn reverts with a single ⌘Z. */
  beginHistoryBatch: () => void;
  endHistoryBatch: () => void;
  /** Copy the selected clip/audio/overlay/title(s) to the timeline clipboard. */
  copySelection: () => boolean;
  /** Empty the timeline clipboard, so the next paste is somebody else's — a
   * frame copied off the preview canvas takes the clipboard over this way. */
  clearClipboard: () => void;
  /** Paste the clipboard at the preview time (the skimmer while one is live,
   * the playhead otherwise) — sliding past anything already on the target
   * lane — and select the pasted item(s). */
  paste: () => boolean;
}

// Per-project undo/redo stacks; both reset when a project loads. Capped so a
// long session (each snapshot deep-copies every clip/cue) can't grow unbounded.
const HISTORY_CAP = 100;
/** Most chat render records a doc keeps — settled cards past this fall off. */
export const RENDERS_CAP = 100;
const history: DocSnapshot[] = [];
const future: DocSnapshot[] = [];
/** A checkpoint captured on pointerdown/focus but not yet committed: it lands
 * in `history` only once an edit actually follows (see flush), so a bare
 * click-to-select never records a no-op snapshot or clears the redo branch. */
let pending: { snap: DocSnapshot; seq: number } | null = null;
/** Bumped whenever the persistable doc actually changes, letting a pending
 * checkpoint tell a real edit apart from a select/seek that touched nothing. */
let docSeq = 0;
/** >0 while a run of edits is being coalesced into one undo step (see
 * beginHistoryBatch). One checkpoint is captured when it goes 0→1. */
let batchDepth = 0;

/** Ids of clips a background generation run placed. Those clips are the
 * orchestrator's to manage — it swaps them idempotently and holds each shot's
 * timeline id — so the user's undo/redo must neither remove nor resurrect them.
 * They are dropped from every history snapshot and re-attached live on restore,
 * so stepping through history can't open a black gap under a running render or
 * bring back a shot the run already replaced. Transient: not persisted and
 * cleared on load, so a reopened project treats them as ordinary clips. */
const genClipIds = new Set<string>();
const genAudioIds = new Set<string>();

/** Timeline clipboard (⌘C/⌘V) — survives across projects in one session. One
 * entry per copied item so a multi-selection round-trips. */
type ClipboardItem =
  | { kind: "clip"; item: VideoClip }
  | { kind: "audio"; item: AudioClip }
  | { kind: "overlay"; item: Overlay }
  | { kind: "transition"; item: TimelineTransition };
let clipboard: ClipboardItem[] = [];

/** How far (seconds) a pasted transition bar reaches for a cut or clip edge
 * around the playhead. Within it the bar lands playing that boundary, like a
 * drop from the panel; past it the bar parks exactly at the playhead. */
const BAR_PASTE_REACH = 1;

/** Bumped whenever subtitle lanes renumber (a track removal). Async work that
 * captured a lane index checks it before landing, so a result can't write to
 * what is now a different language's track. */
let laneEpoch = 0;

/** Fields whose committed change moves or resizes a footprint. `in` checks
 * (not undefined-checks) because some patches clear a field by writing
 * `undefined` (e.g. speed back to 1×). */
const touches = (patch: object, keys: readonly string[]) => keys.some((k) => k in patch);

/**
 * Committed patches keep the lane invariant: segments never overlap. Each
 * settle runs after a committed update lands, scoped to the item's own lane.
 * A move (start / track / lane) re-places the item at the first spot where it
 * intrudes into no resident; a resize (in / out / speed / end) keeps its start
 * and pushes the following same-lane run right by the overflow. Video clips
 * never overlap — a transition is a render-time blend at the cut, not layout.
 * Writes are transient: the committed action that calls this owns the history
 * entry, so the patch and its settle undo as one step.
 */
function settleClipFootprint(id: string, patch: Partial<VideoClip>) {
  const moved = touches(patch, ["start", "track"]);
  if (!moved && !touches(patch, ["in", "out", "speed"])) return;
  const st = useEditor.getState();
  const clip = st.clips.find((c) => c.id === id);
  if (!clip) return;
  const others = st.clips
    .filter((c) => c.id !== id && c.track === clip.track)
    .sort((a, b) => a.start - b.start);
  const len = clipLen(clip);
  if (moved) {
    let at = clip.start;
    for (const c of others) {
      const blockEnd = c.start + clipLen(c);
      if (blockEnd <= at + 1e-3) continue;
      if (c.start >= at + len - 1e-3) break;
      at = blockEnd;
    }
    if (Math.abs(at - clip.start) > 1e-9) st.updateClipTransient(id, { start: at });
    st.sortClips();
    return;
  }
  const next = others.find((c) => c.start >= clip.start - 1e-9);
  if (!next) return;
  const delta = clip.start + len - next.start;
  if (delta <= 1e-9) return;
  useEditor.setState((s) => ({
    clips: s.clips
      .map((c) =>
        c.id !== id && c.track === clip.track && c.start >= next.start - 1e-9
          ? { ...c, start: c.start + delta }
          : c
      )
      .sort((a, b) => a.start - b.start),
  }));
}

function settleAudioFootprint(id: string, patch: Partial<AudioClip>) {
  const moved = touches(patch, ["start", "lane"]);
  if (!moved && !touches(patch, ["in", "out", "speed"])) return;
  const st = useEditor.getState();
  const self = st.audioClips.find((a) => a.id === id);
  if (!self) return;
  const others = st.audioClips
    .filter((a) => a.id !== id && (a.lane ?? 0) === (self.lane ?? 0))
    .sort((a, b) => a.start - b.start);
  const len = clipLen(self);
  if (moved) {
    const at = nextFreeStart(footprints(others), self.start, len);
    if (Math.abs(at - self.start) > 1e-9) st.updateAudioTransient(id, { start: at });
    return;
  }
  const next = others.find((a) => a.start >= self.start - 1e-9);
  if (!next) return;
  const delta = self.start + len - next.start;
  if (delta <= 1e-9) return;
  useEditor.setState((s) => ({
    audioClips: s.audioClips.map((a) =>
      a.id !== id && (a.lane ?? 0) === (self.lane ?? 0) && a.start >= next.start - 1e-9
        ? { ...a, start: a.start + delta }
        : a
    ),
  }));
}

/** Apply a committed title patch and settle its lane. A start move without an
 * explicit end translates the title — its length rides along; an end change
 * resizes in place and pushes the run. Writes are transient: callers own the
 * history entry (exported for the AI's add_title, which patches inside the
 * add's own undo step; everything else comes through `updateOverlay`). */
export function applyOverlayPatchSettled(id: string, patch: OverlayPatch) {
  const st = useEditor.getState();
  const before = st.overlays.find((o) => o.id === id);
  if (!before) return;
  const p = { ...patch };
  if ("start" in p && !("end" in p) && p.start !== undefined)
    p.end = p.start + (before.end - before.start);
  st.updateOverlayTransient(id, p);
  settleOverlayFootprint(id, p);
}

function settleOverlayFootprint(id: string, patch: OverlayPatch) {
  const moved = touches(patch, ["start", "lane"]);
  if (!moved && !touches(patch, ["end"])) return;
  const st = useEditor.getState();
  const self = st.overlays.find((o) => o.id === id);
  if (!self) return;
  const others = st.overlays
    .filter((o) => o.id !== id && (o.lane ?? 0) === (self.lane ?? 0))
    .sort((a, b) => a.start - b.start);
  const len = Math.max(0.2, self.end - self.start);
  if (moved) {
    const at = nextFreeStart(
      others.map((o) => ({ start: o.start, end: o.end })),
      self.start,
      len
    );
    if (Math.abs(at - self.start) > 1e-9)
      st.updateOverlayTransient(id, { start: at, end: at + len });
    return;
  }
  const next = others.find((o) => o.start >= self.start - 1e-9);
  if (!next) return;
  const delta = self.end - next.start;
  if (delta <= 1e-9) return;
  useEditor.setState((s) => ({
    overlays: s.overlays.map((o) =>
      o.id !== id && (o.lane ?? 0) === (self.lane ?? 0) && o.start >= next.start - 1e-9
        ? { ...o, start: o.start + delta, end: o.end + delta }
        : o
    ),
  }));
}

/**
 * Shift a group's other members after one of them has been dragged, keeping
 * the set rigid: everyone moves by the same delta, so durations and the
 * spacing between members survive the move. A shift that would carry a member
 * before zero moves the whole group — the dragged element included — right by
 * the shortfall instead of squashing anyone. Unrelated elements the group
 * lands on are then pushed clear, so no lane ends up with two overlapping
 * overlays.
 *
 * Writes are transient: the caller's gesture already opened the undo step.
 */
export function moveOverlayGroup(anchor: Overlay, delta: number) {
  if (!anchor.groupId || Math.abs(delta) < 1e-9) return;
  const st = useEditor.getState();
  const members = st.overlays.filter((o) => o.groupId === anchor.groupId);
  if (members.length < 2) return;
  // `anchor` is the pre-drag element: it already sits at start + delta, while
  // the peers are still where they were, so both read their target off the
  // original start.
  const startOf = (o: Overlay) => (o.id === anchor.id ? anchor.start : o.start);
  const shortfall = Math.max(0, -Math.min(...members.map((o) => startOf(o) + delta)));
  const d = delta + shortfall;
  st.updateOverlaysTransient(
    members.map((o) => {
      const start = startOf(o) + d;
      return { id: o.id, patch: { start, end: start + (o.end - o.start) } };
    })
  );
  pushOverlaysClearOf(new Set(members.map((o) => o.id)));
}

/** Slide everything that is not in `ids` far enough right, lane by lane, that
 * nothing overlaps the moved set. Shifts only ever grow along a lane, so the
 * elements being pushed keep their own order and spacing. */
function pushOverlaysClearOf(ids: Set<string>) {
  const overlays = useEditor.getState().overlays;
  const moved = overlays.filter((o) => ids.has(o.id));
  const shifted = new Map<string, number>();
  for (const lane of new Set(moved.map((o) => o.lane ?? 0))) {
    const blocks = moved
      .filter((o) => (o.lane ?? 0) === lane)
      .map((o) => ({ start: o.start, end: o.end }));
    const others = overlays
      .filter((o) => !ids.has(o.id) && (o.lane ?? 0) === lane)
      .sort((a, b) => a.start - b.start);
    // Each element takes the first free spot at or after where it was, and
    // never before the one ahead of it — the same slide `nextFreeStart` gives
    // every other placement.
    let floor = -Infinity;
    for (const o of others) {
      const len = o.end - o.start;
      const start = nextFreeStart(blocks, Math.max(o.start, floor), len);
      if (start > o.start + 1e-6) shifted.set(o.id, start - o.start);
      floor = start + len;
    }
  }
  if (shifted.size === 0) return;
  useEditor.setState((s) => ({
    overlays: s.overlays.map((o) => {
      const by = shifted.get(o.id);
      return by ? { ...o, start: o.start + by, end: o.end + by } : o;
    }),
  }));
}

/** Resize a clip's footprint to `newLen` (a trim or speed change), keeping its
 * own track sound: a cut the clip transitions over stays a cut (the run
 * follows the resize so the pair keeps its contact); otherwise a longer
 * footprint pushes the run right by the overflow and a shorter one just opens
 * a gap. Everything is scoped to the clip's track — resizing a track-0 clip
 * never drags the composited layers (or vice versa), so each track's
 * annotations keep the timing they were placed at. One undo step. */
function resizeClipFootprint(clip: VideoClip, patch: Partial<VideoClip>, newLen: number) {
  useEditor.getState().pushHistory();
  const before = useEditor.getState().clips;
  const next = useEditor
    .getState()
    .clips.filter((c) => c.id !== clip.id && c.track === clip.track && c.start >= clip.start)
    .reduce<VideoClip | null>((m, c) => (!m || c.start < m.start ? c : m), null);
  // Whether the pair makes the cut this clip's transition lives on, measured
  // before the resize lands.
  const keepContact = !!next && transitionOverlap(clip, next) > 1e-6;
  useEditor.getState().updateClipTransient(clip.id, patch);
  const nextStart = next?.start ?? Infinity;
  const delta = keepContact
    ? clip.start + newLen - nextStart
    : Math.max(0, clip.start + newLen - nextStart);
  if (Math.abs(delta) > 1e-6) {
    useEditor.setState((st) => ({
      clips: st.clips
        .map((c) =>
          c.id !== clip.id && c.track === clip.track && c.start >= clip.start
            ? { ...c, start: Math.max(0, c.start + delta) }
            : c
        )
        .sort((a, b) => a.start - b.start),
    }));
  }
  // The resized clip's own edge moved, and the run behind it with it, so the
  // bars playing those cuts follow.
  if (useEditor.getState().transitions.length)
    useEditor.setState((st) => ({
      transitions: reanchorTransitions(before, st.clips, st.transitions),
    }));
}
const staleLaneError = {
  subtitleStatus: "error" as const,
  subtitleError: "Subtitle tracks changed while working — run it again.",
};

/** Earliest start at/after `t` where a `len`-long item fits between the
 * occupied `spans` of one lane: each blocker slides the candidate right to its
 * end until a big-enough gap opens. The one placement-collision primitive for
 * every lane track (add, paste, drop). */
export function nextFreeStart(spans: { start: number; end: number }[], t: number, len: number): number {
  const sorted = [...spans].sort((a, b) => a.start - b.start);
  let at = t;
  for (const sp of sorted) {
    if (sp.end <= at + 1e-3) continue;
    if (sp.start >= at + len - 1e-3) break;
    at = sp.end;
  }
  return at;
}

/** The timeline footprints (start/end) of a set of clips, for the `nextFreeStart`
 * collision test. Every placement path — add, drop, paste — occupies the same
 * shape, so they share this instead of re-deriving `start + clipLen` inline. */
export function footprints(items: (VideoClip | AudioClip)[]): { start: number; end: number }[] {
  return items.map((c) => ({ start: c.start, end: c.start + clipLen(c) }));
}

/** Where a scene run's clip lands on a lane that may have moved since the
 * plan. `want` is the target spot (the plan's, or the live end of the run's
 * previous shot). Free residents slide the landing right exactly like
 * `nextFreeStart`; clips in `follow` — the run's own later shots — are never
 * slid past, because that would reorder the story: the landing pushes them
 * (and everything at or after them) right as one run instead. So takes that
 * render out of order still assemble in shot order, whatever the user moved
 * meanwhile. The one placement primitive for generated-scene clips, shared by
 * the live store and the background doc writer. */
export function placeInRun(
  row: { id: string; start: number; end: number }[],
  want: number,
  len: number,
  follow: ReadonlySet<string>
): { start: number; shifts: { id: string; start: number }[] } {
  const sorted = [...row].sort((a, b) => a.start - b.start);
  const followStart = sorted
    .filter((s) => follow.has(s.id))
    .reduce((m, s) => Math.min(m, s.start), Infinity);
  let at = Math.max(0, want);
  for (const sp of sorted) {
    if (sp.start >= followStart - 1e-6) break; // the push below clears these
    if (sp.end <= at + 1e-3) continue;
    if (sp.start >= at + len - 1e-3) break;
    at = sp.end;
  }
  const delta = at + len - followStart;
  const shifts =
    Number.isFinite(followStart) && delta > 1e-9
      ? sorted
          .filter((s) => s.start >= followStart - 1e-6)
          .map((s) => ({ id: s.id, start: s.start + delta }))
      : [];
  return { start: at, shifts };
}

/** Where a `len`-long clip dropped at pointer-time `t` lands on its row,
 * and how the clips after it slide to open room. The drop-at-pointer companion
 * to `nextFreeStart` (which only ever appends): clips whose center sits left of
 * the drop hold their place; the rest shift right as one run, so a clip dropped
 * into a leading gap or between two others inserts there instead of piling up at
 * the end when it is longer than the gap. */
export function rippleInsert(
  row: VideoClip[],
  t: number,
  len: number
): { start: number; shifts: { id: string; start: number }[] } {
  const items = row
    .map((c) => ({ id: c.id, start: c.start, len: clipLen(c) }))
    .sort((a, b) => a.start - b.start);
  const center = t + len / 2;
  const before = items.filter((c) => c.start + c.len / 2 <= center);
  const after = items.filter((c) => c.start + c.len / 2 > center);
  const floor = before.reduce((m, c) => Math.max(m, c.start + c.len), 0);
  const start = Math.max(t, floor);
  const delta = after.length ? Math.max(0, start + len - after[0].start) : 0;
  const shifts = delta > 0 ? after.map((c) => ({ id: c.id, start: c.start + delta })) : [];
  return { start, shifts };
}

/** POST a transcribe spec and poll the job to completion. Returns the cues, or
 * null when the user switches projects mid-run. Throws user-facing errors.
 * Shared with the brief-to-video transcribe adapter. */
export async function runTranscription(projectId: string, spec: object): Promise<SubtitleCue[] | null> {
  // A cloud or browser project's media isn't on the engine's disk, so the
  // engine can't render the mix — the browser does, and then hands it to
  // whoever can transcribe it: this Mac when the app is running (on-device,
  // free, real word timings), the hosted route otherwise (included up to the
  // account's allowance, metered past it). A local project skips all of it;
  // the engine already holds the media and runs the whole job.
  if (getBackend().kind !== "local") {
    const s = spec as CloudTranscribeSpec;
    if (s.clips.length === 0 && s.audio.length === 0) {
      throw new Error("Add audio or video to the timeline first.");
    }
    const stale = () => useEditor.getState().projectId !== projectId;
    const mix = await renderMix(projectId, s);
    if (stale()) return null;
    if (!mix) return []; // nothing audible — no speech, like the engine's short-circuit
    const samples = mix.getChannelData(0);
    if (hasLocalCompute()) {
      try {
        return await engineTranscribeSamples(samples, s.duration, s.locale, stale);
      } catch {
        // The app went away, or on-device speech is unavailable on this Mac.
        // The hosted route still works, so the user never sees the difference.
      }
    }
    // The hosted model reads cue times off the audio by ear, so they land near
    // the speech rather than on it; the mix is right here to settle it.
    const cues = await transcribeSamples(samples, s.locale, stale);
    return cues && alignCues(cues, samples, mix.sampleRate, { snap: 0.6 });
  }
  // The engine runs one transcription at a time; the client-side turn queue
  // keeps this job from colliding with a background sweep chunk (or vice
  // versa) and failing on the busy slot.
  return withEngineStt(async () => {
    const res = await apiFetch(`/api/cut/projects/${projectId}/transcribe`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(spec),
    });
    const body = await apiJson<{ id?: string }>(res);
    if (!res.ok || !body.id) throw new Error(body.error ?? "Transcription failed to start.");
    for (;;) {
      await new Promise((r) => setTimeout(r, 600));
      if (useEditor.getState().projectId !== projectId) return null;
      const st = await apiFetch(`/api/cut/projects/${projectId}/transcribe?job=${body.id}`);
      if (!st.ok) throw new Error("The transcription job was lost — try again.");
      const status = (await st.json()) as { status: string; error?: string; cues?: SubtitleCue[] };
      if (status.status === "error") throw new Error(status.error ?? "Transcription failed.");
      if (status.status === "done") {
        return useEditor.getState().projectId === projectId ? (status.cues ?? []) : null;
      }
    }
  });
}

// Doc-mutating state: in a read-only shared view the set wrapper drops these
// keys from every write, so edit paths anywhere in the app become no-ops.
// Hydration (loadProject, the shared-view poll) escapes via `hydrating`.
const DOC_KEYS = [
  "projectName",
  "saveState",
  "assets",
  "clips",
  "transitions",
  "audioClips",
  "overlays",
  "templates",
  "aspect",
  "fadeIn",
  "fadeOut",
  "background",
  "publish",
  "notes",
  "subtitles",
  "genvideo",
  "renders",
] as const;
let hydrating = false;

/**
 * The invariants every write to the store passes through, wherever it comes
 * from: a read-only project takes no doc changes, the track stack stays
 * grounded, the per-clip transition/anim fields stay caches of the bars, and
 * the playhead stays inside the timeline.
 *
 * The clip fields are what the preview and the export actually render from,
 * so a write that moved clips or bars without re-deriving them would ship a
 * blend at a joint that no longer has one. This runs inside `setState`
 * itself, so no caller — action, module helper, or anything outside this
 * file — can write past it.
 */
function normalizeWrite(prev: EditorState, incoming: Partial<EditorState>): Partial<EditorState> {
  let next = incoming;
  if (prev.readOnly && !hydrating) {
    next = { ...next };
    for (const k of DOC_KEYS) delete (next as Record<string, unknown>)[k];
  }
  if (next.clips) next = { ...next, clips: groundTracks(next.clips) };
  if (next.clips || next.transitions) {
    const clips = next.clips ?? prev.clips;
    const derived = deriveTransitionFields(clips, next.transitions ?? prev.transitions);
    if (derived !== clips) next = { ...next, clips: derived };
  }
  // The playhead cannot outlive the timeline. Deleting the last of a long
  // row shortens the project under a playhead standing past the new end,
  // which leaves the readout ahead of the total and — since the playhead is
  // placed with a transform, and transforms count toward scrollable
  // overflow — stretches the scroll area into empty space. Clamping here
  // covers every edit that shortens anything, present and future.
  if (next.clips || next.audioClips || next.overlays) {
    clampPlayhead(
      projectDuration({
        clips: next.clips ?? prev.clips,
        audioClips: next.audioClips ?? prev.audioClips,
        overlays: next.overlays ?? prev.overlays,
      })
    );
  }
  return next;
}

/**
 * The whole cut as a transcribe spec: the track-0 spans in order with their
 * gaps as explicit silent spacers, plus every audible soundtrack and layer
 * clip as a positioned source. Speech can live anywhere on the timeline, so
 * dialogue on a layer clip gets captioned and a layer-only cut still works.
 *
 * One builder serves both readers of the cut's audio — the transcriber and
 * the mix render the caption alignment pass measures against — so a caption is
 * always checked against the same audio it was written from. Null when the
 * timeline has nothing audible.
 */
function cutTranscribeSpec(
  s: Pick<EditorState, "clips" | "assets" | "audioClips" | "overlays">,
  locale?: string
): CloudTranscribeSpec | null {
  const spans = getClipSpans(s.clips, s.assets);
  const duration = projectDuration(s);
  const assetById = new Map(s.assets.map((a) => [a.id, a]));
  const audio = s.audioClips
    .filter((a) => !a.hidden && a.start < duration && assetById.has(a.assetId))
    .map((a) => ({
      file: assetById.get(a.assetId)!.fileName,
      in: a.in,
      out: a.out,
      start: a.start,
      volume: a.volume,
      speed: a.speed,
    }))
    .concat(
      overlayLayers(s.clips)
        .filter((c) => !c.hidden && !c.muted && c.start < duration && assetById.has(c.assetId))
        .map((c) => ({
          file: assetById.get(c.assetId)!.fileName,
          in: c.in,
          out: c.out,
          start: c.start,
          volume: 1,
          speed: c.speed,
        }))
    );
  if (spans.length === 0 && audio.length === 0) return null;
  const silentSpacer = (len: number) => ({ file: "", in: 0, out: len, muted: true, speed: 1, transition: 0 });
  return {
    duration,
    ...(locale ? { locale } : {}),
    // The mix is a sequential fold, so gaps between the free-placed clips ship
    // as explicit silent spacers (empty file). An overlay-only cut has no
    // track-0 spans: the whole bed is one spacer.
    clips:
      spans.length === 0
        ? [silentSpacer(duration)]
        : spanSequence(spans).flatMap(({ gapBefore, span: sp }) => [
            ...(gapBefore > 0 ? [silentSpacer(gapBefore)] : []),
            {
              file: sp.asset.fileName,
              in: sp.clip.in,
              out: sp.clip.out,
              muted: sp.clip.muted,
              speed: clipSpeed(sp.clip),
              // The clamped cross-dissolve overlap, so the mix overlaps clip
              // audio the same way the timeline does and cues stay in sync.
              transition: sp.transitionOut,
            },
          ]),
    audio,
  };
}

export const useEditor = create<EditorState>((baseSet, get, api) => {
  // Normalizing is bolted onto setState itself, not onto a local helper the
  // actions happen to use: the store's own module-level helpers write through
  // `useEditor.setState`, and one of those skipping the derive is how a clip
  // kept rendering a transition its bar had already left.
  const set = (
    partial:
      | Partial<EditorState>
      | ((s: EditorState) => Partial<EditorState>),
    replace?: boolean
  ) =>
    baseSet(
      (prev) => normalizeWrite(prev, typeof partial === "function" ? partial(prev) : partial),
      replace as false | undefined
    );
  api.setState = set as typeof api.setState;

  const snapshot = (): DocSnapshot => {
    const { clips, transitions, audioClips, overlays, subtitles } = get();
    return {
      // Render-owned clips are excluded — history captures the user's timeline,
      // not the background run's placements (restoreDoc re-attaches the live ones).
      clips: clips.filter((c) => !genClipIds.has(c.id)).map((c) => ({ ...c })),
      transitions: transitions.map((t) => ({ ...t })),
      audioClips: audioClips.filter((c) => !genAudioIds.has(c.id)).map((c) => ({ ...c })),
      overlays: overlays.map((o) => ({ ...o })),
      subtitles: {
        ...subtitles,
        cues: subtitles.cues.map((c) => ({ ...c, words: c.words?.map((w) => ({ ...w })) })),
      },
    };
  };

  /** Apply a history snapshot, re-attaching the render-owned clips it omitted so
   * an undo/redo never disturbs a background run's placements. The live gen
   * clips are read at restore time, so the set is always current. */
  const restoreDoc = (snap: DocSnapshot) => {
    const { clips, audioClips } = get();
    const genClips = clips.filter((c) => genClipIds.has(c.id));
    const genAudio = audioClips.filter((c) => genAudioIds.has(c.id));
    set({
      ...snap,
      clips: [...snap.clips, ...genClips].sort((a, b) => a.start - b.start),
      audioClips: [...snap.audioClips, ...genAudio],
      selection: null,
      multiSelection: [],
    });
  };

  /** Seal the deferred checkpoint: commit it to history only if the doc
   * changed since it was taken; otherwise drop it and leave redo intact. */
  const flush = () => {
    if (!pending) return;
    const p = pending;
    pending = null;
    if (docSeq !== p.seq) {
      history.push(p.snap);
      if (history.length > HISTORY_CAP) history.shift();
      future.length = 0; // a real edit invalidates the redo branch
    }
  };

  const push = () => {
    // Inside a batch a single checkpoint (taken at beginHistoryBatch) already
    // covers every edit, so individual pushes are no-ops.
    if (batchDepth > 0) return;
    flush(); // seal the previous edit's checkpoint before starting a new one
    pending = { snap: snapshot(), seq: docSeq };
  };

  /** Remove one gen-swap placement (video or audio) by id: the clip, its
   * gen-set entry, and any selection pointing at it. No push() — the
   * orchestrator's swaps stay off the undo stack. */
  const removeGenPlacement = (id: string, kind: "clip" | "audio") => {
    const exists =
      kind === "clip"
        ? get().clips.some((c) => c.id === id)
        : get().audioClips.some((c) => c.id === id);
    if (!exists) return;
    (kind === "clip" ? genClipIds : genAudioIds).delete(id);
    set((s) => {
      const keep = (sel: Selection) => !(!!sel && sel.kind === kind && sel.id === id);
      const multiSelection = s.multiSelection.filter(keep);
      return {
        ...(kind === "clip"
          ? { clips: s.clips.filter((c) => c.id !== id) }
          : { audioClips: s.audioClips.filter((c) => c.id !== id) }),
        multiSelection,
        selection: keep(s.selection) ? s.selection : multiSelection[multiSelection.length - 1] ?? null,
      };
    });
  };

  /** Shared add for overlay elements: aim for the playhead, slide to the
   * home lane's next free slot so the new element never lands on an existing
   * one, and select the result. One undo step.
   *
   * Effects keep their own rows. An effect filters the picture under it while
   * the rest draw on top, so they read as separate work and the timeline
   * carries them as separate rows — which is also what lets effect rows lead
   * the band (`overlayLaneOrder`). */
  const addElement = (
    kind: OverlayKind,
    build: (start: number, end: number, lane: number) => Overlay,
    /** A drop aims at where it landed — a time on the timeline and, when it
     * came down on a row, that row. Absent, the playhead and the home row. */
    aim: { at?: number; lane?: number; len?: number } = {}
  ) => {
    push();
    const place =
      aim.lane !== undefined
        ? { lane: aim.lane, shiftDown: false }
        : elementPlacement(get().overlays, kind);
    // A row opening at the top pushes every existing row down one.
    const rest = place.shiftDown
      ? get().overlays.map((o) => ({ ...o, lane: (o.lane ?? 0) + 1 }))
      : get().overlays;
    const t = aim.at ?? playheadAt();
    const total = totalDuration(get().clips);
    const taken = rest
      .filter((o) => (o.lane ?? 0) === place.lane)
      .map((o) => ({ start: o.start, end: o.end }));
    const len = aim.len ?? 3;
    // Keep the element within the film; with no clips yet there is no film
    // to stay inside, so it lands where it was aimed.
    const start = nextFreeStart(taken, total > 0 ? Math.min(t, Math.max(0, total - 0.5)) : t, len);
    const overlay = build(start, Math.min(start + len, Math.max(total, start + len)), place.lane);
    set(() => ({
      overlays: [...rest, overlay],
      ...sole({ kind: "overlay", id: overlay.id }),
    }));
  };

  /** Reset to an empty, loading project and drain any background doc writes
   * still queued for it, so no open ever reads a half-written document. */
  const resetForOpen = async (id: string) => {
    // Blob URLs minted for the project being left go with it; the next open
    // of that project re-registers what its store holds. A re-open of the
    // same project keeps them — its state still points at them.
    const prev = get().projectId;
    if (prev && prev !== id) revokeRegistered(`/api/cut/projects/${prev}/`);
    // Coming back to a project whose revoke is still waiting on an in-flight
    // render's hold: the subtree is live again, so the revoke no longer
    // applies — hydration is about to reuse those registrations.
    cancelRevoke(`/api/cut/projects/${id}/`);
    history.length = 0;
    future.length = 0;
    pending = null;
    // A fresh project owns no live run — any prior run's render-owned ids are
    // stale, and the loaded clips are ordinary, fully-undoable content.
    genClipIds.clear();
    genAudioIds.clear();
    hydrating = true;
    set({
      projectId: id,
      loaded: false,
      loadError: null,
      saveState: "saved",
      resumePush: false,
      assets: [],
      loadingMedia: new Set<string>(),
      clips: [],
      transitions: [],
      audioClips: [],
      overlays: [],
      templates: [],
      aspect: "9:16",
      aspectTouched: false,
      fadeIn: 0,
      fadeOut: 0,
      background: DEFAULT_BACKGROUND,
      selection: null,
      multiSelection: [],
      playing: false,
      previewStopAt: null,
      subtitles: emptySubtitles(),
      subtitleLane: 0,
      subtitleStatus: "idle",
      subtitleError: null,
      exportOpen: false,
      genvideo: undefined,
      renders: [],
      firstOpen: undefined,
    });
    hydrating = false;
    // A background scene run may still be writing this project's doc — drain
    // its queued writes so the open never reads a half-written doc. Ordering
    // matters: projectId is set (loaded false) BEFORE this await, so a write
    // arriving during the drain waits for the load (projectWriteMode) instead
    // of queueing a doc write the drain would miss — nothing can land between
    // the drain and the fetch that follows. Lazy import: docWriter reads store
    // helpers, so a static import would be a cycle.
    await import("./genvideo/docWriter").then((m) => m.docWriterIdle(id)).catch(() => {});
  };

  return {
    projectId: null,
    projectName: "",
    loaded: false,
    loadEpoch: 0,
    loadError: null,
    saveState: "saved",
    resumePush: false,
    readOnly: false,
    sharedFeatures: null,

    assets: [],
    loadingMedia: new Set<string>(),
    clips: [],
    transitions: [],
    audioClips: [],
    overlays: [],
    templates: [],
    aspect: "9:16",
    aspectTouched: false,
    fadeIn: 0,
    fadeOut: 0,
    background: DEFAULT_BACKGROUND,
    selection: null,
    multiSelection: [],
    selectedKey: null,
    playing: false,
    previewStopAt: null,
    pxPerSec: 60,
    timelineH: TIMELINE_H_DEFAULT,
    publish: { caption: "", tags: "", soundTitle: "", handle: "" },
    notes: { text: "", publishedAt: "", links: [] },
    subtitles: emptySubtitles(),
    subtitleLane: 0,
    subtitleStatus: "idle",
    subtitleError: null,
    subtitleStartedAt: null,
    exportOpen: false,
    dropActive: null,
    aiOpen: typeof window !== "undefined" && localStorage.getItem("cut-ai-open") === "1",
    genvideo: undefined,
    renders: [],

    loadProject: async (id, opts) => {
      // In-place re-reads (the viewer's change poll, a conflict reload) say so
      // explicitly: the whole point of those is that the stored copy has moved
      // on, so the snapshot below is exactly the wrong thing to paint. A fresh
      // open of a project this store happened to hold last — going home and
      // clicking back in — is not a re-read, and gets the snapshot's head
      // start like any other open.
      const inPlace = opts?.inPlace === true;
      await resetForOpen(id);

      // One shape of hydration, used by both the snapshot painted below and
      // the live document that replaces it, so the legacy migrations happen
      // once per document rather than once per code path.
      const hydrate = (doc: Partial<ProjectDoc>, assets: MediaAsset[], ui: ProjectUiState) =>
        get().applyDocState(doc, assets, ui);

      // The live document goes out first, so everything below is a head start
      // on it and never a substitute for it.
      const docReq = apiFetch(`/api/cut/projects/${id}`);
      const uiReq = loadUiState(id);
      let landed = false;
      const settle = () => {
        landed = true;
      };
      void docReq.then(settle, settle);

      // Paint the copy this browser last held. It is written on load and on
      // every successful save, so for the ordinary case — reopening your own
      // project — it is the document, and the editor draws on the next frame
      // instead of a round trip later. Whether it is still on screen when the
      // live document arrives decides how that one is applied.
      let paintedFromCache = false;
      // The painted snapshot held unsaved edits: they resume as the document,
      // and autosave pushes them back up.
      let paintedDirty = false;
      let dirtyBase: string | null = null;
      try {
        const [cached, ui] = inPlace
          ? [null, null]
          : await Promise.all([readCachedDoc(id), uiReq]);
        const stored = cached?.doc;
        const openable = () => !landed && get().projectId === id && !get().loaded;
        if (stored && ui && openable()) {
          const stale = stored.assets ?? [];
          // Signed R2 links are cached alongside the doc, so a snapshot open
          // hands its clips the very URLs the live load is about to hand
          // them: identical strings, so nothing reloads when it lands. Local
          // and browser projects serve their own bytes; their URLs are minted
          // per session and never cached.
          const kind = getBackend().kind;
          const links =
            kind === "local" || kind === "browser"
              ? null
              : await readCachedMediaLinks(id, stale.map((a) => a.fileName));
          if (openable()) {
            hydrate(
              stored,
              stale.map((a) => ({ ...a, url: links?.urls.get(a.fileName) ?? mediaUrl(id, a.fileName) })),
              ui
            );
            // Keep the re-mint schedule honest even if the live load never
            // arrives: these links do expire.
            markSignedBatch(id, links?.expiresAt ?? null);
            paintedFromCache = true;
            if (cached?.dirty && !get().readOnly) {
              paintedDirty = true;
              dirtyBase = cached.baseVersion;
              // The push must carry the version these edits were made on top
              // of, so a server copy that moved on answers 409 instead of
              // being overwritten. Pinned now, before any save can dispatch.
              if (getBackend().kind === "cloud") pinDocBase(id, dirtyBase);
              set({ saveState: "dirty", resumePush: true });
            }
          }
        }
      } catch {
        // A snapshot miss costs a spinner and nothing else.
      }

      try {
        const [res, ui] = await Promise.all([docReq, uiReq]);
        if (!res.ok) {
          // Gone, or no longer ours to read: the server is the authority on
          // that, so retire the snapshot and show the error even when it is
          // already on screen. Any other status is a server having a bad
          // moment, which is the same case as not reaching it at all.
          if ([401, 403, 404].includes(res.status)) {
            pinDocBase(id, null);
            dropCachedDoc(id);
            set({ loaded: false, loadError: "This project no longer exists.", resumePush: false });
            return;
          }
          throw new Error("This project could not be loaded.");
        }
        const doc = (await res.json()) as ProjectDoc;
        const assets: MediaAsset[] = doc.assets.map((a) => ({
          ...a,
          url: mediaUrl(id, a.fileName),
        }));
        // Cloud and shared media ride signed R2 URLs, batch-minted once per
        // load; the /media route's 302 stays the fallback for anything the
        // mint misses. mediaLinks re-mints the batch as it nears expiry.
        if (getBackend().kind !== "local") {
          // A cloud project plays what this browser already holds — imports
          // that haven't drained plus files cached from earlier reads — so
          // only the rest asks for signed links.
          const held = new Map<string, string>();
          if (getBackend().kind === "cloud") {
            await Promise.all(
              assets.map(async (a) => {
                const url = await localMediaUrl(id, a.fileName);
                if (url) held.set(a.fileName, url);
              })
            );
          }
          const missing = assets.filter((a) => !held.has(a.fileName));
          const signed = await fetchSignedMediaUrls(id, missing.map((a) => a.fileName));
          for (const a of assets) {
            a.url = held.get(a.fileName) ?? signed.urls.get(a.fileName) ?? a.url;
          }
          markSignedBatch(id, signed.expiresAt);
          // A browser project's "mint" hands back session blob URLs, dead on
          // the next load — only time-limited signed links are worth caching.
          if (getBackend().kind !== "browser") {
            writeCachedMediaLinks(id, signed.urls, signed.expiresAt);
          }
          if (getBackend().kind === "cloud") {
            // Pull every missing file into the browser store behind the
            // editor, nearest timeline use first, and swap each asset onto
            // its local bytes as it lands — scrubbing goes local front to
            // back, and the next open plays entirely from disk.
            const firstUse = new Map<string, number>();
            for (const c of [...doc.clips, ...doc.audioClips]) {
              const asset = doc.assets.find((x) => x.id === c.assetId);
              if (!asset) continue;
              firstUse.set(
                asset.fileName,
                Math.min(firstUse.get(asset.fileName) ?? Infinity, c.start)
              );
            }
            const queue = missing
              .flatMap((a) => {
                const url = signed.urls.get(a.fileName);
                return url ? [{ fileName: a.fileName, url, type: a.type }] : [];
              })
              .sort(
                (x, y) =>
                  (firstUse.get(x.fileName) ?? Infinity) - (firstUse.get(y.fileName) ?? Infinity)
              );
            // Video reads through the chunk cache and plays from its first
            // chunk, so only whole-file fetches show as loading.
            set({
              loadingMedia: new Set(
                queue.filter((f) => f.type !== "video").map((f) => f.fileName)
              ),
            });
            prefetchCloudMedia(id, queue, (fileName, url) => {
              const st = get();
              if (st.projectId !== id) return;
              if (url) st.applyMediaUrls(new Map([[fileName, url]]));
              // Video was never in the set; re-seating it would hand every
              // subscriber a new Set identity for no change.
              if (!st.loadingMedia.has(fileName)) return;
              set((s) => {
                const next = new Set(s.loadingMedia);
                next.delete(fileName);
                return { loadingMedia: next };
              });
            });
          }
        } else {
          markSignedBatch(id, null);
        }
        // Ledger pins survive the reload; once the document is in hand, its
        // unsynced imports re-enter the upload queue. Lazy import: media.ts
        // reaches back into the store.
        const resumeUploads = () =>
          void import("./media")
            .then((m) => m.resumePendingUploads(id))
            .catch(() => {});
        // A dirty snapshot resumes only onto the version its edits were made
        // on top of. The server having moved past that base is a conflict,
        // and the server wins it the way it wins any conflict — even over
        // edits made in the seconds since the resume painted, which were
        // built on the losing base.
        const serverVersion = res.headers.get("x-cut-doc-version");
        const staleDirty =
          paintedDirty && getBackend().kind === "cloud" && dirtyBase !== serverVersion;
        if (staleDirty) {
          pinDocBase(id, null);
          set({ saveState: "saved", resumePush: false });
        }
        // The snapshot is on screen and is the newer document — resumed
        // unsaved work, an undoable edit made since it painted, or a
        // project-level one like a rename that autosave has already marked
        // dirty. Replacing it would throw that work away, so only the media
        // links go in; the edits don't touch them and they do expire. The
        // edits save as usual, and a stored copy that really has moved on
        // answers that save with a conflict, which reloads through this same
        // path.
        if (
          paintedFromCache &&
          !staleDirty &&
          (paintedDirty || history.length > 0 || get().saveState !== "saved")
        ) {
          get().applyMediaUrls(new Map(assets.map((a) => [a.fileName, a.url])));
          resumeUploads();
          return;
        }
        writeCachedDoc(id, doc);
        hydrate(doc, assets, ui);
        resumeUploads();
      } catch (err) {
        // Couldn't reach the server. A snapshot already on screen is the
        // better answer than an error page: the project is open and editable,
        // a version behind at worst, and autosave retries until the link is
        // back.
        if (!paintedFromCache) {
          set({ loadError: err instanceof Error ? err.message : String(err) });
        }
      } finally {
        hydrating = false;
      }
    },

    applyDocState: (doc, assets, ui) => {
      const docClips = doc.clips ?? [];
      // Older docs stored video track 0 packed (array order implied the
      // position); bake explicit starts in once so every clip is free-placed.
      const legacy = (docClips as LegacyClip[]).some((c) => typeof c.start !== "number");
      const folded = (legacy ? packStarts(docClips as LegacyClip[]) : docClips).map((c) => ({
        ...c,
        track: c.track ?? 0,
      }));
      // Older docs kept tracks other than 0 in a separate `overlayClips` array;
      // fold them into the one clip list (each already carries its `track`).
      // Entries whose id already sits in `clips` are the same clip persisted
      // twice by a version-skewed save (an older engine keeps overlayClips
      // after a merged client writes the folded list) — keep the folded copy.
      // Entries with track 0 were unreachable dead data under the split shape
      // (never rendered, never played); promoting them would insert them into
      // track 0's sequence, so they stay dropped.
      const seen = new Set(folded.map((c) => c.id));
      const legacyLayers = (doc.overlayClips ?? []).filter(
        (c) => c.track !== 0 && !seen.has(c.id)
      );
      // Tracks number 0..N bottom-up. Docs saved when tracks could go
      // negative (backdrop rows below the spine) lift wholesale so the
      // lowest row becomes track 0 — the bottom row is the spine now.
      const joined = [...folded, ...legacyLayers];
      const lift = Math.max(0, ...joined.map((c) => -c.track));
      const lifted = lift ? joined.map((c) => ({ ...c, track: c.track + lift })) : joined;
      // Stamp `kind: "text"` on pre-union titles so every in-memory element
      // carries its discriminant; the serializer strips it back. Effects
      // saved onto a shared row move to one of their own, and a clip graded
      // back when a look was a clip property gets that grade as an element
      // over it — so a project made before either rule reads like a new one.
      // The behind-speaker boolean becomes an inverted subject mask on load,
      // so one mask model covers it everywhere in memory and on save. Key
      // tracks written by the retired move picker lift into the move slot,
      // leaving `kf` to the keys users set themselves.
      const stamped = liftMoveTracks(
        normalizeElementLanes(migrateBehindSubject(stampOverlayKinds(doc.overlays ?? [])))
      );
      const subtitles = doc.subtitles ?? emptySubtitles();
      // Docs saved when edge transition styles existed convert them into the
      // equivalent clip animations, and docs saved when a transition was a
      // physical overlap pull their intruding clips apart — clips never
      // overlap, whatever wrote the file. Pulling them apart lengthens the
      // cut, so the whole document goes through it together.
      const merged = separateOverlaps({
        clips: migrateLegacyTransitions(lifted),
        audioClips: doc.audioClips ?? [],
        overlays: stamped,
        cues: subtitles.cues,
      });
      const withLooks =
        liftClipLooks(merged.clips, merged.overlays, getClipSpans(merged.clips, assets)) ?? {
          clips: merged.clips,
          overlays: merged.overlays,
        };
      hydrating = true;
      try {
        set({
          projectName: doc.name ?? "",
          assets,
          clips: withLooks.clips,
          // Bars from the doc, plus one adopted for each transition/animation
          // a pre-bar doc stored as a clip field.
          transitions: adoptTransitionFields(
            withLooks.clips,
            sanitizeTransitions(doc.transitions)
          ),
          audioClips: merged.audioClips,
          overlays: withLooks.overlays,
          templates: doc.templates ?? [],
          aspect: normalizeAspect(doc.aspect) ?? "9:16",
          aspectTouched: doc.aspect !== undefined,
          fadeIn: doc.fadeIn ?? 0,
          fadeOut: doc.fadeOut ?? 0,
          background: projectBackground(doc.background),
          // View state lives in IndexedDB; doc.ui covers projects saved
          // before the move.
          pxPerSec: clampPps(ui.pxPerSec ?? doc.ui?.pxPerSec ?? 60),
          timelineH: Math.max(
            TIMELINE_H_MIN,
            Math.min(timelineHMax(), ui.timelineH ?? TIMELINE_H_DEFAULT)
          ),
          publish: {
            caption: doc.publish?.caption ?? "",
            tags: doc.publish?.tags ?? "",
            soundTitle: doc.publish?.soundTitle ?? "",
            handle: doc.publish?.handle ?? "",
          },
          notes: {
            text: doc.notes?.text ?? "",
            publishedAt: doc.notes?.publishedAt ?? "",
            links: doc.notes?.links ?? [],
          },
          subtitles: { ...subtitles, cues: merged.cues },
          subtitleStatus: merged.cues.length > 0 ? "ready" : "idle",
          genvideo: doc.genvideo ?? undefined,
          renders: Array.isArray(doc.renders) ? doc.renders : [],
          firstOpen: doc.firstOpen,
          loaded: true,
          loadEpoch: get().loadEpoch + 1,
        });
      } finally {
        // Reset on every path: a doc bad enough to throw inside set() must
        // never leave the store treating ordinary writes as hydration.
        hydrating = false;
      }
    },

    openProjectDoc: async (id, doc, assets) => {
      await resetForOpen(id);
      get().applyDocState(doc, assets, {});
    },

    setProjectName: (name) => set({ projectName: name }),
    setSaveState: (s) => set({ saveState: s }),
    setSharedView: (features) => set({ readOnly: true, sharedFeatures: features }),

    // Clone so each persist yields a fresh top-level reference: the orchestrator
    // mutates one project object in place, and autosave detects a genvideo change
    // by identity — without the clone every save after the first looks unchanged
    // and the plan is never written back.
    setGenvideo: (project) => set({ genvideo: project ? { ...project } : undefined }),

    upsertRender: (r) =>
      set((s) => ({
        renders: [...s.renders.filter((x) => x.id !== r.id), r].slice(-RENDERS_CAP),
      })),
    removeRenders: (ids) =>
      set((s) => ({ renders: s.renders.filter((x) => !ids.includes(x.id)) })),

    placeGenClip: (assetId, startSec, endSec, opts) => {
      const asset = get().assets.find((a) => a.id === assetId);
      if (!asset || (asset.type !== "video" && asset.type !== "image")) return null;
      const slot = Math.max(MIN_LEN, endSec - startSec);
      // The reviewer's chosen window: start the source there, clamped so the
      // slot still fits inside the file.
      const srcIn =
        asset.type === "video"
          ? Math.min(Math.max(0, opts?.srcInSec ?? 0), Math.max(0, asset.duration - slot))
          : 0;
      // Fill the slot exactly so the track never opens a gap between shots —
      // fillSlot mirrors the plan's frame-coverage invariant at this boundary.
      const { out, speed } = fillSlot(
        asset.type,
        Math.max(MIN_LEN, asset.duration - srcIn),
        slot,
        SPEED_MIN
      );
      // Land through the run placement primitive against the live row: after
      // the furthest clip the run's earlier shots still hold, never past a
      // later shot's clip, slid clear of everything else on the track.
      const row = track0Clips(get().clips);
      const spans = row.map((c) => ({ id: c.id, start: c.start, end: c.start + clipLen(c) }));
      const anchorIds = new Set(opts?.anchorAfterIds ?? []);
      const prevEnd = spans
        .filter((s) => anchorIds.has(s.id))
        .reduce((m, s) => Math.max(m, s.end), -1);
      const len = speed !== undefined && speed > 0 ? out / speed : out;
      const { start, shifts } = placeInRun(
        spans,
        prevEnd >= 0 ? prevEnd : Math.max(0, startSec),
        Math.max(MIN_LEN, len),
        new Set(opts?.followClipIds ?? [])
      );
      const move = new Map(shifts.map((sh) => [sh.id, sh.start]));
      const clip: VideoClip = {
        id: uid(),
        assetId,
        track: 0,
        start,
        in: srcIn,
        out: srcIn + out,
        // Muted only when the caller asks — a provided-audio scene mutes its
        // b-roll under the user's spine, but a generated scene keeps the shot's
        // own audio (the model burns the narration into the clip) audible.
        muted: opts?.muted ?? true,
        ...(speed !== undefined ? { speed } : {}),
      };
      // Render-owned: no push(), and tracked so history snapshots exclude it —
      // the orchestrator manages this clip (it swaps clips idempotently), so a
      // mid-render Cmd+Z must not pull a shot out from under the run.
      genClipIds.add(clip.id);
      set((s) => {
        const clips = [
          ...s.clips.map((c) => (move.has(c.id) ? { ...c, start: move.get(c.id)! } : c)),
          clip,
        ].sort((a, b) => a.start - b.start);
        return { clips, transitions: reanchorTransitions(s.clips, clips, s.transitions) };
      });
      return clip.id;
    },

    placeGenAudio: (assetId, startSec, durSec, opts) => {
      const asset = get().assets.find((a) => a.id === assetId);
      if (!asset || asset.type !== "audio") return null;
      const out = Math.min(asset.duration, Math.max(MIN_LEN, durSec));
      const lane = opts?.lane ?? 0;
      // Slide to the lane's next free slot so a background run never lands a
      // bed or voiceover on top of a sound the user placed meanwhile.
      const taken = footprints(get().audioClips.filter((a) => (a.lane ?? 0) === lane));
      const clip: AudioClip = {
        id: uid(),
        assetId,
        start: nextFreeStart(taken, Math.max(0, startSec), out),
        in: 0,
        out,
        volume: opts?.volume ?? 1,
        ...(opts?.duck !== undefined && opts.duck < 1 ? { duck: Math.max(0, opts.duck) } : {}),
        ...(lane > 0 ? { lane } : {}),
      };
      // Render-owned: no push(), tracked so history snapshots exclude it.
      genAudioIds.add(clip.id);
      set((s) => ({ audioClips: [...s.audioClips, clip] }));
      return clip.id;
    },

    // Shared body of the two gen-swap removals: drop the clip, its gen-set
    // entry, and any selection pointing at it — with no push(), because the
    // orchestrator's swaps stay off the undo stack.
    removeClipById: (id) => removeGenPlacement(id, "clip"),

    adoptGenClips: (clipIds, audioIds) => {
      for (const id of clipIds) genClipIds.add(id);
      for (const id of audioIds) genAudioIds.add(id);
      // The invariant is exact: no history snapshot holds a gen-owned clip.
      // Re-adopting released clips (a regeneration after done) scrubs them back
      // out of existing snapshots, so the eventual release grafts exactly one
      // copy and an undo never restores a clip the run has since swapped.
      const scrub = (snap: DocSnapshot) => {
        snap.clips = snap.clips.filter((c) => !genClipIds.has(c.id));
        snap.audioClips = snap.audioClips.filter((c) => !genAudioIds.has(c.id));
      };
      for (const snap of history) scrub(snap);
      for (const snap of future) scrub(snap);
      if (pending) scrub(pending.snap);
    },

    releaseGenClips: () => {
      if (genClipIds.size === 0 && genAudioIds.size === 0) return;
      const { clips, audioClips } = get();
      const relClips = clips.filter((c) => genClipIds.has(c.id));
      const relAudio = audioClips.filter((c) => genAudioIds.has(c.id));
      // Every existing snapshot omitted these clips; splice them in at their
      // final state (matching what restoreDoc would have re-attached), so an
      // undo across the run's lifetime never drops a paid render.
      const graft = (snap: DocSnapshot) => {
        if (relClips.length > 0) {
          const have = new Set(snap.clips.map((c) => c.id));
          snap.clips = [...snap.clips, ...relClips.filter((c) => !have.has(c.id)).map((c) => ({ ...c }))].sort(
            (a, b) => a.start - b.start
          );
        }
        if (relAudio.length > 0) {
          const have = new Set(snap.audioClips.map((c) => c.id));
          snap.audioClips = [...snap.audioClips, ...relAudio.filter((c) => !have.has(c.id)).map((c) => ({ ...c }))];
        }
      };
      for (const snap of history) graft(snap);
      for (const snap of future) graft(snap);
      if (pending) graft(pending.snap);
      genClipIds.clear();
      genAudioIds.clear();
    },

    removeAudioById: (id) => removeGenPlacement(id, "audio"),

    pushHistory: push,

    beginHistoryBatch: () => {
      if (batchDepth === 0) {
        flush(); // seal any prior edit before opening the batch
        pending = { snap: snapshot(), seq: docSeq };
      }
      batchDepth++;
    },
    endHistoryBatch: () => {
      batchDepth = Math.max(0, batchDepth - 1);
      if (batchDepth === 0) flush(); // commit the whole run as one undo step
    },

    setAspect: (a) => {
      const n = normalizeAspect(a);
      if (n) set({ aspect: n, aspectTouched: true });
    },
    setProjectFade: (patch) => {
      const clamp = (v: number | undefined) =>
        v === undefined ? undefined : Math.max(0, Math.min(TRANSITION_MAX, v));
      set((s) => ({
        fadeIn: clamp(patch.fadeIn) ?? s.fadeIn,
        fadeOut: clamp(patch.fadeOut) ?? s.fadeOut,
      }));
    },

    setBackground: (hex) => set({ background: projectBackground(hex) }),

    addAsset: (asset) =>
      set((s) => {
        // The first video in an untouched project decides the starting frame
        // (landscape footage → 16:9, portrait → 9:16); the user can switch it
        // any time from the top bar. A deliberately chosen aspect wins — the
        // guess never overrides it.
        const guess =
          !s.aspectTouched &&
          (asset.type === "video" || asset.type === "image") &&
          asset.width !== undefined &&
          asset.height !== undefined &&
          s.clips.length === 0 &&
          !s.assets.some((a) => a.type === "video" || a.type === "image")
            ? asset.width >= asset.height
              ? ("16:9" as Aspect)
              : ("9:16" as Aspect)
            : null;
        return { assets: [...s.assets, asset], ...(guess ? { aspect: guess } : {}) };
      }),

    updateAsset: (id, patch) => {
      // A read-only view still takes runtime enrichment (signed URLs,
      // filmstrips, waveforms) — decorative fields only; doc fields stay
      // stripped with every other edit.
      if (get().readOnly) {
        const runtime: Partial<MediaAsset> = {};
        if (patch.url !== undefined) runtime.url = patch.url;
        if (patch.thumbs !== undefined) runtime.thumbs = patch.thumbs;
        if (patch.thumbStep !== undefined) runtime.thumbStep = patch.thumbStep;
        if (patch.peaks !== undefined) runtime.peaks = patch.peaks;
        if (Object.keys(runtime).length === 0) return;
        hydrating = true;
        try {
          set((s) => ({
            assets: s.assets.map((a) => (a.id === id ? { ...a, ...runtime } : a)),
          }));
        } finally {
          hydrating = false;
        }
        return;
      }
      set((s) => ({
        assets: s.assets.map((a) => (a.id === id ? { ...a, ...patch } : a)),
      }));
    },

    applyMediaUrls: (urls) => {
      hydrating = true;
      try {
        set((s) => ({
          assets: s.assets.map((a) => {
            // An import still uploading plays from local bytes; a signed URL
            // for an object that hasn't landed would only 404. An asset the
            // browser store serves keeps its blob URL — link rotation is for
            // links that expire.
            if (a.upload || resolveRegisteredBlob(a.url)) return a;
            const url = urls.get(a.fileName);
            return url && url !== a.url ? { ...a, url } : a;
          }),
        }));
      } finally {
        hydrating = false;
      }
    },

    removeAsset: (id) => {
      const st = get();
      const gone = st.assets.find((a) => a.id === id);
      if (!gone) return;
      // The media file dies with its last referencing asset, so no undo may
      // bring a clip of it back to point at bytes that no longer exist: take
      // this asset's clips out of every snapshot that holds them. Deleting an
      // asset is not itself undoable, and the asset list is not in a snapshot,
      // so nothing can resurrect either the clips or the file.
      const scrub = (snap: DocSnapshot) => {
        snap.clips = snap.clips.filter((c) => c.assetId !== id);
        snap.audioClips = snap.audioClips.filter((c) => c.assetId !== id);
      };
      for (const snap of history) scrub(snap);
      for (const snap of future) scrub(snap);
      if (pending) scrub(pending.snap);
      const dropFile = () => {
        const s = get();
        if (!s.projectId || s.assets.some((a) => a.fileName === gone.fileName)) return;
        void apiFetch(
          `/api/cut/projects/${s.projectId}/media/${encodeURIComponent(gone.fileName)}`,
          { method: "DELETE" }
        ).catch(() => {});
        // A cloud project's browser-store copy — pin, bytes, and blob URL —
        // dies with the cloud object.
        if (getBackend().kind === "cloud") void dropLocalMedia(s.projectId, gone.fileName);
      };
      // An unreferenced asset is no doc edit: history snapshots don't cover
      // the asset list, so removing one must not open a checkpoint or churn
      // the clip arrays (a fresh clips reference would count as a doc change
      // and wipe the redo branch).
      if (
        !st.clips.some((c) => c.assetId === id) &&
        !st.audioClips.some((c) => c.assetId === id)
      ) {
        set((s) => ({ assets: s.assets.filter((a) => a.id !== id) }));
        dropFile();
        return;
      }
      // Cascade removes this asset's clips; every clip is free-positioned, so
      // the rest of the timeline (and its annotations) stays where it is.
      set((s) => {
        const goneClips = new Set(s.clips.filter((c) => c.assetId === id).map((c) => c.id));
        const goneAudio = new Set(s.audioClips.filter((c) => c.assetId === id).map((c) => c.id));
        const keep = (sel: Selection) =>
          !!sel &&
          !((sel.kind === "clip" && goneClips.has(sel.id)) ||
            (sel.kind === "audio" && goneAudio.has(sel.id)));
        const multiSelection = s.multiSelection.filter(keep);
        return {
          assets: s.assets.filter((a) => a.id !== id),
          clips: s.clips.filter((c) => c.assetId !== id),
          audioClips: s.audioClips.filter((c) => c.assetId !== id),
          multiSelection,
          selection: keep(s.selection) ? s.selection : multiSelection[multiSelection.length - 1] ?? null,
        };
      });
      dropFile();
    },

    addClipFromAsset: (assetId, start) => {
      const asset = get().assets.find((a) => a.id === assetId);
      if (!asset || (asset.type !== "video" && asset.type !== "image")) return;
      push();
      const out = asset.type === "image" ? IMAGE_CLIP_SECONDS : asset.duration;
      const len = Math.max(MIN_LEN, out);
      const row = track0Clips(get().clips);
      // An explicit target time always wins (a drop at the pointer, AI placing
      // b-roll against a voiceover). Without one: the first clip on an empty
      // track 0 anchors at 0 — a lone clip with dead space before it reads as
      // broken — and later clips append at the end of the row.
      const want = Math.max(0, start ?? (row.length === 0 ? 0 : totalDuration(get().clips)));
      const taken = footprints(row);
      const clip: VideoClip = {
        id: uid(),
        assetId,
        track: 0,
        start: nextFreeStart(taken, want, len),
        in: 0,
        out,
        muted: false,
      };
      set((s) => ({
        clips: [...s.clips, clip].sort((a, b) => a.start - b.start),
        ...sole({ kind: "clip", id: clip.id }),
      }));
    },

    addAudioFromAsset: (assetId, start, opts) => {
      const asset = get().assets.find((a) => a.id === assetId);
      if (!asset || asset.type !== "audio") return;
      push();
      // Within its lane the clip slides to the next free slot at or after the
      // target so it never lands on top of an existing sound.
      const want = Math.max(0, start ?? playheadAt());
      const len = Math.max(MIN_LEN, asset.duration);
      const lane = opts?.lane ?? 0;
      const taken = footprints(get().audioClips.filter((a) => (a.lane ?? 0) === lane));
      const clip: AudioClip = {
        id: uid(),
        assetId,
        start: nextFreeStart(taken, want, len),
        in: 0,
        out: asset.duration,
        volume: 1,
        ...(opts?.duck !== undefined && opts.duck < 1
          ? { duck: Math.max(0, opts.duck) }
          : {}),
        ...(lane > 0 ? { lane } : {}),
      };
      set((s) => ({
        audioClips: [...s.audioClips, clip],
        ...sole({ kind: "audio", id: clip.id }),
      }));
    },

    addAssetAtPlayhead: (assetId) => {
      const asset = get().assets.find((a) => a.id === assetId);
      if (!asset) return;
      const t = Math.max(0, previewAt());
      // A row fits when `nextFreeStart` keeps the clip at the preview time
      // itself; the scan climbs until one does. A brand-new row always fits,
      // so the clip lands under the indicator no matter how full the stack is.
      // The add itself delegates to the placement actions (which checkpoint
      // history themselves), landing exactly at `t` on the fitting row.
      const firstFit = <T extends VideoClip | AudioClip>(
        all: T[],
        rowOf: (c: T) => number,
        len: number
      ) => {
        const top = all.reduce((m, c) => Math.max(m, rowOf(c)), 0);
        let row = 0;
        while (
          row <= top &&
          nextFreeStart(footprints(all.filter((c) => rowOf(c) === row)), t, len) >= t + 1e-3
        )
          row++;
        return row;
      };
      if (asset.type === "audio") {
        const lane = firstFit(get().audioClips, (c) => c.lane ?? 0, Math.max(MIN_LEN, asset.duration));
        get().addAudioFromAsset(assetId, t, { lane });
        return;
      }
      if (asset.type !== "video" && asset.type !== "image") return;
      const out = asset.type === "image" ? IMAGE_CLIP_SECONDS : asset.duration;
      const track = firstFit(get().clips, (c) => c.track, Math.max(MIN_LEN, out));
      get().addVideoFromAsset(assetId, { kind: "track", track }, t);
    },

    addOverlay: (aim) => {
      // Seed the visual style from the last-used title so repeated titles in a
      // project share one look; fall back to the built-in defaults.
      const remembered = readTextStyle();
      addElement("text", (start, end, lane) => ({
        id: uid(),
        kind: "text",
        text: "Your text",
        start,
        end,
        x: 0.5,
        y: 0.42,
        size: remembered.size ?? 88,
        font: remembered.font ?? "sf",
        weight: remembered.weight ?? 700,
        italic: remembered.italic,
        color: remembered.color ?? "#FFFFFF",
        stroke: remembered.stroke,
        letterSpacing: remembered.letterSpacing,
        lineHeight: remembered.lineHeight,
        align: remembered.align,
        shadow: remembered.shadow ?? true,
        plate: remembered.plate ?? false,
        plateColor: remembered.plateColor,
        plateOpacity: remembered.plateOpacity,
        plateRadius: remembered.plateRadius,
        lane,
      }), aim);
    },

    addShape: (shape, aim) => {
      const frame = frameOf(get().aspect);
      // A square-reading default box whatever the aspect; lines/arrows are a
      // wider box whose height is the stroke thickness.
      const w = lineLikeShape(shape) ? 0.42 : 0.3;
      const h =
        shape === "line"
          ? 6 / frame.h
          : shape === "arrow"
            ? 10 / frame.h
            : (w * frame.w) / frame.h;
      addElement(
        "shape",
        (start, end, lane) => ({
          id: uid(),
          kind: "shape",
          shape,
          start,
          end,
          x: 0.5,
          y: 0.5,
          w,
          h,
          fill: "#FFFFFF",
          lane,
        }),
        aim
      );
    },

    addSticker: (init) => {
      if (!init.assetId) return;
      addElement(
        "sticker",
        (start, end, lane) => ({
          id: uid(),
          kind: "sticker",
          assetId: init.assetId,
          ...(init.lottie ? { lottie: true } : {}),
          start,
          end,
          x: 0.5,
          y: 0.5,
          w: 0.25,
          lane,
        }),
        { at: init.at, lane: init.lane }
      );
    },

    addEffect: (effect, aim) => {
      // A picture effect grades a stretch of the picture, and a clip is the
      // stretch people mean: dropped anywhere over one, it opens covering that
      // clip. Off the end of the cut it falls back to the standard length.
      //
      // A treatment on the sound is aimed at a moment — a line, a word, the
      // bar the music turns on — so it opens at the standard length where it
      // was dropped and is stretched from there.
      const s0 = get();
      const t = aim?.at ?? playheadAt();
      const span = isAudioEffect(effect)
        ? undefined
        : getClipSpans(s0.clips, s0.assets).find(
            (sp) => t >= sp.start - 1e-6 && t < sp.start + sp.len
          );
      const fit = span ? { at: span.start, len: span.len } : { at: aim?.at };
      addElement(
        "effect",
        (start, end, lane) => ({
          id: uid(),
          kind: "effect",
          effect,
          start,
          end,
          x: 0.5,
          y: 0.5,
          lane,
        }),
        { ...fit, lane: aim?.lane }
      );
    },

    // The non-transient updaters are just a checkpoint plus the live update.
    updateClip: (id, patch) => {
      push();
      const before = get().clips;
      get().updateClipTransient(id, patch);
      settleClipFootprint(id, patch);
      // A resize moves the clip's own edge and pushes the run behind it, so
      // the bars playing those cuts follow. A move is the user placing the
      // clip somewhere, and a bar stays exactly where it was left.
      if (
        get().transitions.length &&
        !touches(patch, ["start", "track"]) &&
        touches(patch, ["in", "out", "speed"])
      )
        set((s) => ({ transitions: reanchorTransitions(before, s.clips, s.transitions) }));
    },

    setClipSpeed: (id, speed) => {
      const clip = get().clips.find((c) => c.id === id);
      if (!clip) return;
      const clamped = Math.max(SPEED_FLOOR, speed);
      if (Math.abs(clamped - clipSpeed(clip)) < 1e-4) return;
      resizeClipFootprint(clip, { speed: clamped }, Math.max(MIN_LEN, (clip.out - clip.in) / clamped));
    },

    setClipTrim: (id, nextIn, nextOut) => {
      const clip = get().clips.find((c) => c.id === id);
      if (!clip) return;
      if (Math.abs(nextIn - clip.in) < 1e-6 && Math.abs(nextOut - clip.out) < 1e-6) return;
      resizeClipFootprint(clip, { in: nextIn, out: nextOut }, (nextOut - nextIn) / clipSpeed(clip));
    },

    setClipTransition: (id, seconds, style) => {
      const s = get();
      const clip = s.clips.find((c) => c.id === id);
      if (!clip) return;
      // The bar playing this clip's tail — its cut, or its open end. Failing
      // that, a parked bar already ending on the tail: with several tracks
      // cutting at the same instant, this clip's bar can lose its boundary
      // claim to a newer neighbour, and writing a fresh bar on top of it
      // would stack identical twins.
      const roles = resolveTransitions(s.clips, s.transitions);
      const tail = clip.start + clipLen(clip);
      const existing =
        s.transitions.find((t) =>
          (roles.get(t.id) ?? []).some((r) => r.kind !== "in" && r.clipId === id)
        ) ??
        s.transitions.find(
          (t) => !roles.has(t.id) && Math.abs(t.start + t.seconds - tail) <= TOUCH_EPS
        );
      const value = Math.max(0, Math.min(TRANSITION_MAX, seconds));
      if (value <= 0) {
        if (existing) get().removeTransition(existing.id);
        return;
      }
      const bar = {
        start: tail - value,
        seconds: value,
        style: style ?? existing?.style ?? "crossfade",
      };
      push();
      set((s2) => ({
        transitions: existing
          ? s2.transitions.map((t) => (t.id === existing.id ? { ...t, ...bar } : t))
          : [...s2.transitions, { id: uid(), ...bar }],
      }));
    },

    setClipAnim: (id, which, anim) => {
      const s = get();
      const clip = s.clips.find((c) => c.id === id);
      if (!clip) return;
      // The bar riding this edge, whichever role it resolved to there — or a
      // parked bar already sitting exactly on it, so a lost boundary claim
      // (another track cutting at the same instant) never stacks a twin.
      const roles = resolveTransitions(s.clips, s.transitions);
      const edgeAt = which === "in" ? clip.start : clip.start + clipLen(clip);
      const existing =
        s.transitions.find((t) =>
          (roles.get(t.id) ?? []).some(
            (r) => r.clipId === id && (which === "in" ? r.kind === "in" : r.kind !== "in")
          )
        ) ??
        s.transitions.find(
          (t) =>
            !roles.has(t.id) &&
            Math.abs((which === "in" ? t.start : t.start + t.seconds) - edgeAt) <= TOUCH_EPS
        );
      if (!anim || !ANIM_STYLE_IDS.includes(anim.style)) {
        if (existing) get().removeTransition(existing.id);
        return;
      }
      const seconds = Math.max(0.1, Math.min(TRANSITION_MAX, anim.seconds));
      const bar = {
        start: which === "in" ? edgeAt : edgeAt - seconds,
        seconds,
        style: transitionStyleOfAnim(anim.style),
      };
      push();
      set((s2) => ({
        transitions: existing
          ? s2.transitions.map((t) => (t.id === existing.id ? { ...t, ...bar } : t))
          : [...s2.transitions, { id: uid(), ...bar }],
      }));
    },

    reanchorBars: (before) => {
      const s = get();
      if (s.transitions.length === 0) return;
      const next = reanchorTransitions(before, s.clips, s.transitions);
      if (next !== s.transitions) set({ transitions: next });
    },

    addTransition: (bar) => {
      const id = uid();
      push();
      set((s) => ({
        transitions: [
          ...s.transitions,
          { id, start: bar.start, seconds: clampBarSeconds(bar.seconds), style: bar.style },
        ],
      }));
      return id;
    },

    updateTransition: (id, patch) => {
      push();
      get().updateTransitionTransient(id, patch);
    },

    updateTransitionTransient: (id, patch) => {
      set((s) => ({
        transitions: s.transitions.map((t) =>
          t.id === id
            ? {
                ...t,
                ...patch,
                ...(patch.seconds !== undefined ? { seconds: clampBarSeconds(patch.seconds) } : {}),
              }
            : t
        ),
      }));
    },

    removeTransition: (id) => {
      if (!get().transitions.some((t) => t.id === id)) return;
      push();
      set((s) => {
        const keep = (sel: Selection) => !(sel?.kind === "transition" && sel.id === id);
        const multiSelection = s.multiSelection.filter(keep);
        return {
          transitions: s.transitions.filter((t) => t.id !== id),
          multiSelection,
          selection: keep(s.selection)
            ? s.selection
            : multiSelection[multiSelection.length - 1] ?? null,
        };
      });
    },

    updateAudio: (id, patch) => {
      push();
      get().updateAudioTransient(id, patch);
      settleAudioFootprint(id, patch);
    },

    setTrackHidden: (track, hidden) => {
      const ids = get()
        .clips.filter((c) => c.track === track && !!c.hidden !== hidden)
        .map((c) => c.id);
      if (!ids.length) return;
      push();
      get().updateClipsTransient(ids.map((id) => ({ id, patch: { hidden } })));
    },

    setTrackMuted: (track, muted) => {
      const ids = get()
        .clips.filter((c) => c.track === track && c.muted !== muted)
        .map((c) => c.id);
      if (!ids.length) return;
      push();
      get().updateClipsTransient(ids.map((id) => ({ id, patch: { muted } })));
    },

    setAudioLaneHidden: (lane, hidden) => {
      const ids = get()
        .audioClips.filter((a) => (a.lane ?? 0) === lane && !!a.hidden !== hidden)
        .map((a) => a.id);
      if (!ids.length) return;
      push();
      get().updateAudiosTransient(ids.map((id) => ({ id, patch: { hidden } })));
    },

    setTextLaneHidden: (lane, hidden) => {
      const ids = get()
        .overlays.filter((o) => (o.lane ?? 0) === lane && !!o.hidden !== hidden)
        .map((o) => o.id);
      if (!ids.length) return;
      push();
      get().updateOverlaysTransient(ids.map((id) => ({ id, patch: { hidden } })));
    },

    moveVideoTrack: (from, to) => {
      const s = get();
      const map = rowRenumber([...new Set(s.clips.map((c) => c.track))].sort((a, b) => a - b), from, to);
      if (!map) return;
      push();
      s.updateClipsTransient(
        s.clips
          .filter((c) => map.get(c.track) !== c.track)
          .map((c) => ({ id: c.id, patch: { track: map.get(c.track)! } }))
      );
    },

    moveOverlayLane: (from, to) => {
      const s = get();
      const map = rowRenumber(overlayLaneOrder(s.overlays), from, to);
      if (!map) return;
      push();
      s.updateOverlaysTransient(
        s.overlays
          .filter((o) => map.get(o.lane ?? 0) !== (o.lane ?? 0))
          .map((o) => ({ id: o.id, patch: { lane: map.get(o.lane ?? 0)! } }))
      );
    },

    moveAudioLane: (from, to) => {
      const s = get();
      const map = rowRenumber(
        [...new Set(s.audioClips.map((a) => a.lane ?? 0))].sort((a, b) => a - b),
        from,
        to
      );
      if (!map) return;
      push();
      s.updateAudiosTransient(
        s.audioClips
          .filter((a) => map.get(a.lane ?? 0) !== (a.lane ?? 0))
          .map((a) => {
            const lane = map.get(a.lane ?? 0)!;
            return { id: a.id, patch: { lane: lane > 0 ? lane : undefined } };
          })
      );
    },
    updateOverlay: (id, patch) => {
      push();
      applyOverlayPatchSettled(id, patch);
    },

    setOverlayKey: (id, tLocal, patch, opts) => {
      const o = get().overlays.find((x) => x.id === id);
      if (!o) return;
      const t = Math.max(0, Math.min(tLocal, Math.max(0.1, o.end - o.start)));
      const existing = o.kf?.find((k) => Math.abs(k.t - t) <= KEY_EPSILON);
      // A brand-new key holds the pose the element already had at `t`, so
      // adding one changes nothing until something edits it.
      const next = { ...(existing ?? keyAt(o, t)), ...patch, t };
      if (!opts?.transient) push();
      get().updateOverlayTransient(id, { kf: upsertKey(o.kf, next) });
    },

    removeOverlay: (id) => {
      if (!get().overlays.some((o) => o.id === id)) return;
      push();
      set((s) => ({
        overlays: s.overlays.filter((o) => o.id !== id),
        selection: s.selection?.kind === "overlay" && s.selection.id === id ? null : s.selection,
        multiSelection: s.multiSelection.filter(
          (x) => !(x && x.kind === "overlay" && x.id === id)
        ),
      }));
    },

    removeOverlayKey: (id, tLocal) => {
      const o = get().overlays.find((x) => x.id === id);
      if (!o || !o.kf?.length) return;
      const kf = removeKeyAt(o.kf, tLocal);
      if (kf.length === o.kf.length) return;
      push();
      // The last key going means the element holds its own resting pose
      // again, so the track leaves with it.
      get().updateOverlayTransient(id, { kf: kf.length ? kf : undefined });
    },

    selectOverlayKey: (id, tLocal) => {
      const o = get().overlays.find((x) => x.id === id);
      if (!o) return;
      get().select({ kind: "overlay", id });
      set({ selectedKey: { kind: "overlay", id, t: tLocal, track: "pose" } });
    },

    moveOverlayKey: (id, fromT, toT, opts) => {
      const o = get().overlays.find((x) => x.id === id);
      if (!o?.kf?.length) return;
      const key = o.kf.find((k) => Math.abs(k.t - fromT) <= KEY_EPSILON);
      if (!key) return;
      const t = Math.max(0, Math.min(toT, Math.max(0.1, o.end - o.start)));
      if (!opts?.transient) push();
      get().updateOverlayTransient(id, {
        kf: upsertKey(removeKeyAt(o.kf, fromT), { ...key, t }),
      });
      // The pick follows the key it is on, so dragging never drops it.
      const picked = get().selectedKey;
      if (
        picked &&
        picked.kind === "overlay" &&
        picked.track === "pose" &&
        picked.id === id &&
        Math.abs(picked.t - fromT) <= KEY_EPSILON
      ) {
        set({ selectedKey: { kind: "overlay", id, t, track: "pose" } });
      }
    },

    clearOverlayKeys: (id) => {
      const o = get().overlays.find((x) => x.id === id);
      if (!o?.kf?.length) return;
      push();
      get().updateOverlayTransient(id, { kf: undefined });
    },

    setOverlayMaskKey: (id, tLocal, patch, opts) => {
      const o = get().overlays.find((x) => x.id === id);
      if (!o?.mask) return;
      const t = Math.max(0, Math.min(tLocal, Math.max(0.1, o.end - o.start)));
      const existing = o.mask.kf?.find((k) => Math.abs(k.t - t) <= KEY_EPSILON);
      // A brand-new key holds the geometry the mask already had at `t`, so
      // adding one changes nothing until something edits it.
      const next = { ...(existing ?? maskKeyAt(o.mask, t)), ...patch, t };
      if (!opts?.transient) push();
      get().updateOverlayTransient(id, { mask: { ...o.mask, kf: upsertKey(o.mask.kf, next) } });
    },

    removeOverlayMaskKey: (id, tLocal) => {
      const o = get().overlays.find((x) => x.id === id);
      if (!o?.mask?.kf?.length) return;
      const kf = removeKeyAt(o.mask.kf, tLocal);
      if (kf.length === o.mask.kf.length) return;
      push();
      // The last key going means the mask holds its own resting geometry
      // again, so the track leaves with it.
      get().updateOverlayTransient(id, { mask: { ...o.mask, kf: kf.length ? kf : undefined } });
    },

    selectOverlayMaskKey: (id, tLocal) => {
      const o = get().overlays.find((x) => x.id === id);
      if (!o) return;
      get().select({ kind: "overlay", id });
      set({ selectedKey: { kind: "overlay", id, t: tLocal, track: "mask" } });
    },

    moveOverlayMaskKey: (id, fromT, toT, opts) => {
      const o = get().overlays.find((x) => x.id === id);
      if (!o?.mask?.kf?.length) return;
      const key = o.mask.kf.find((k) => Math.abs(k.t - fromT) <= KEY_EPSILON);
      if (!key) return;
      const t = Math.max(0, Math.min(toT, Math.max(0.1, o.end - o.start)));
      if (!opts?.transient) push();
      get().updateOverlayTransient(id, {
        mask: { ...o.mask, kf: upsertKey(removeKeyAt(o.mask.kf, fromT), { ...key, t }) },
      });
      // The pick follows the key it is on, so dragging never drops it.
      const picked = get().selectedKey;
      if (
        picked &&
        picked.kind === "overlay" &&
        picked.track === "mask" &&
        picked.id === id &&
        Math.abs(picked.t - fromT) <= KEY_EPSILON
      ) {
        set({ selectedKey: { kind: "overlay", id, t, track: "mask" } });
      }
    },

    clearOverlayMaskKeys: (id) => {
      const o = get().overlays.find((x) => x.id === id);
      if (!o?.mask?.kf?.length) return;
      push();
      get().updateOverlayTransient(id, { mask: { ...o.mask, kf: undefined } });
    },

    setClipMaskKey: (id, tLocal, patch, opts) => {
      const c = get().clips.find((x) => x.id === id);
      if (!c?.mask) return;
      const len = Math.max(0.1, (c.out - c.in) / clipSpeed(c));
      const t = Math.max(0, Math.min(tLocal, len));
      const existing = c.mask.kf?.find((k) => Math.abs(k.t - t) <= KEY_EPSILON);
      const next = { ...(existing ?? maskKeyAt(c.mask, t)), ...patch, t };
      if (!opts?.transient) push();
      get().updateClipTransient(id, { mask: { ...c.mask, kf: upsertKey(c.mask.kf, next) } });
    },

    removeClipMaskKey: (id, tLocal) => {
      const c = get().clips.find((x) => x.id === id);
      if (!c?.mask?.kf?.length) return;
      const kf = removeKeyAt(c.mask.kf, tLocal);
      if (kf.length === c.mask.kf.length) return;
      push();
      get().updateClipTransient(id, { mask: { ...c.mask, kf: kf.length ? kf : undefined } });
    },

    selectClipMaskKey: (id, tLocal) => {
      const c = get().clips.find((x) => x.id === id);
      if (!c) return;
      get().select({ kind: "clip", id });
      set({ selectedKey: { kind: "clip", id, t: tLocal, track: "mask" } });
    },

    moveClipMaskKey: (id, fromT, toT, opts) => {
      const c = get().clips.find((x) => x.id === id);
      if (!c?.mask?.kf?.length) return;
      const key = c.mask.kf.find((k) => Math.abs(k.t - fromT) <= KEY_EPSILON);
      if (!key) return;
      const t = Math.max(0, Math.min(toT, clipLen(c)));
      if (!opts?.transient) push();
      get().updateClipTransient(id, {
        mask: { ...c.mask, kf: upsertKey(removeKeyAt(c.mask.kf, fromT), { ...key, t }) },
      });
      // The pick follows the key it is on, so dragging never drops it.
      const picked = get().selectedKey;
      if (
        picked &&
        picked.kind === "clip" &&
        picked.track === "mask" &&
        picked.id === id &&
        Math.abs(picked.t - fromT) <= KEY_EPSILON
      ) {
        set({ selectedKey: { kind: "clip", id, t, track: "mask" } });
      }
    },

    clearClipMaskKeys: (id) => {
      const c = get().clips.find((x) => x.id === id);
      if (!c?.mask?.kf?.length) return;
      push();
      get().updateClipTransient(id, { mask: { ...c.mask, kf: undefined } });
    },

    setClipKey: (id, tLocal, patch, opts) => {
      const c = get().clips.find((x) => x.id === id);
      if (!c) return;
      const t = Math.max(0, Math.min(tLocal, clipLen(c)));
      const existing = c.kf?.find((k) => Math.abs(k.t - t) <= KEY_EPSILON);
      // A brand-new key holds the pose the clip already had at `t`, so
      // adding one changes nothing until something edits it.
      const next = { ...(existing ?? { t, ...clipPoseAt(c, t) }), ...patch, t };
      if (!opts?.transient) push();
      get().updateClipTransient(id, { kf: upsertKey(c.kf, next) });
    },

    removeClipKey: (id, tLocal) => {
      const c = get().clips.find((x) => x.id === id);
      if (!c?.kf?.length) return;
      const kf = removeKeyAt(c.kf, tLocal);
      if (kf.length === c.kf.length) return;
      push();
      // The last key going means the clip rests in its region again, so the
      // track leaves with it.
      get().updateClipTransient(id, { kf: kf.length ? kf : undefined });
    },

    selectClipKey: (id, tLocal) => {
      const c = get().clips.find((x) => x.id === id);
      if (!c) return;
      get().select({ kind: "clip", id });
      set({ selectedKey: { kind: "clip", id, t: tLocal, track: "pose" } });
    },

    moveClipKey: (id, fromT, toT, opts) => {
      const c = get().clips.find((x) => x.id === id);
      if (!c?.kf?.length) return;
      const key = c.kf.find((k) => Math.abs(k.t - fromT) <= KEY_EPSILON);
      if (!key) return;
      const t = Math.max(0, Math.min(toT, clipLen(c)));
      if (!opts?.transient) push();
      get().updateClipTransient(id, { kf: upsertKey(removeKeyAt(c.kf, fromT), { ...key, t }) });
      // The pick follows the key it is on, so dragging never drops it.
      const picked = get().selectedKey;
      if (
        picked &&
        picked.kind === "clip" &&
        picked.track === "pose" &&
        picked.id === id &&
        Math.abs(picked.t - fromT) <= KEY_EPSILON
      ) {
        set({ selectedKey: { kind: "clip", id, t, track: "pose" } });
      }
    },

    clearClipKeys: (id) => {
      const c = get().clips.find((x) => x.id === id);
      if (!c?.kf?.length) return;
      push();
      get().updateClipTransient(id, { kf: undefined });
    },

    updateOverlayTransient: (id, patch) =>
      set((s) => ({
        overlays: s.overlays.map((o) => (o.id === id ? { ...o, ...patch } : o)),
      })),

    updateOverlaysTransient: (patches) =>
      set((s) => {
        const byId = new Map(patches.map((p) => [p.id, p.patch]));
        return {
          overlays: s.overlays.map((o) => {
            const patch = byId.get(o.id);
            return patch ? { ...o, ...patch } : o;
          }),
        };
      }),

    updateAudiosTransient: (patches) =>
      set((s) => {
        const byId = new Map(patches.map((p) => [p.id, p.patch]));
        return {
          audioClips: s.audioClips.map((c) => {
            const patch = byId.get(c.id);
            return patch ? { ...c, ...patch } : c;
          }),
        };
      }),

    updateCuesTransient: (patches) =>
      set((s) => {
        const byId = new Map(patches.map((p) => [p.id, p.patch]));
        return {
          subtitles: {
            ...s.subtitles,
            cues: s.subtitles.cues.map((c) => {
              const patch = byId.get(c.id);
              return patch ? { ...c, ...patch } : c;
            }),
          },
        };
      }),

    updateClipTransient: (id, patch) =>
      set((s) => ({
        clips: s.clips.map((c) => (c.id === id ? { ...c, ...patch } : c)),
      })),

    updateClipsTransient: (patches) =>
      set((s) => {
        const byId = new Map(patches.map((p) => [p.id, p.patch]));
        return {
          clips: s.clips.map((c) => {
            const patch = byId.get(c.id);
            return patch ? { ...c, ...patch } : c;
          }),
        };
      }),

    sortClips: () =>
      set((s) => ({ clips: [...s.clips].sort((a, b) => a.start - b.start) })),

    updateAudioTransient: (id, patch) =>
      set((s) => ({
        audioClips: s.audioClips.map((c) =>
          c.id === id ? { ...c, ...patch } : c
        ),
      })),

    moveClip: (id, toIndex) => {
      // The AI reorder op: lift the clip out (its old spot becomes a gap) and
      // open a slot at the target index — the landing clip and everything
      // after it shift right by the moved footprint, everything else keeps
      // its absolute time, so audio, titles, and captions stay synced to the
      // clips they annotate. Pointer drags never come here — they free-place
      // through the lane coordinator.
      const row = track0Clips(get().clips).sort((a, b) => a.start - b.start);
      const from = row.findIndex((c) => c.id === id);
      if (from < 0) return;
      const to = Math.max(0, Math.min(row.length - 1, toIndex));
      if (to === from) return;
      push();
      const moved = row[from];
      const others = row.filter((c) => c.id !== id);
      const len = clipLen(moved);
      const anchor = to < others.length ? others[to] : null;
      const newStart = anchor ? anchor.start : totalDuration(others);
      set((s) => ({
        clips: [
          ...overlayLayers(s.clips),
          ...others.map((c) =>
            c.start >= newStart - 1e-6 ? { ...c, start: c.start + len } : c
          ),
          { ...moved, start: newStart },
        ].sort((a, b) => a.start - b.start),
      }));
    },

    addVideoFromAsset: (assetId, place, start) => {
      const asset = get().assets.find((a) => a.id === assetId);
      if (!asset || (asset.type !== "video" && asset.type !== "image")) return;
      const out = asset.type === "image" ? IMAGE_CLIP_SECONDS : asset.duration;
      push();
      const { track, start: at, shifts } = landOnPlacement(
        get().clips,
        place,
        start,
        Math.max(MIN_LEN, out)
      );
      const move = new Map(shifts.map((sh) => [sh.id, sh.start]));
      // Full-frame by default: covers track 0 ("topmost plays"); the inspector
      // regions it (split half / corner PiP).
      const v: VideoClip = { id: uid(), assetId, track, start: at, in: 0, out, muted: false };
      set((s) =>
        placedState(
          s,
          [
            ...shiftTracksUp(s.clips, place).map((c) =>
              move.has(c.id) ? { ...c, start: move.get(c.id)! } : c
            ),
            v,
          ],
          v.id
        )
      );
    },

    dropVideoClip: (id, place, start) => {
      const src = get().clips.find((c) => c.id === id);
      if (!src) return;
      // No checkpoint here: the lane coordinator's drag gesture already pushed
      // one at pointer-down, so the whole move is a single undo step.
      if (place.kind === "track" && place.track === src.track) {
        return; // a same-track move commits through the lane coordinator
      }

      // The clip leaves its track, so the hole it leaves closes behind it:
      // the source row's later clips slide left by its length. Matching by id
      // keeps the closure correct through an insert's track renumbering.
      const srcLen = clipLen(src);
      const closing: [string, number][] = get()
        .clips.filter(
          (c) => c.track === src.track && c.id !== id && c.start > src.start + 1e-9
        )
        .map((c) => [c.id, Math.max(0, c.start - srcLen)]);

      const { track, start: at, shifts } = landOnPlacement(
        get().clips,
        place,
        start,
        srcLen,
        id
      );
      const move = new Map([...shifts.map((sh) => [sh.id, sh.start] as const), ...closing]);
      set((st) => {
        // Inserting a new track opens the slot by renumbering the others; the
        // moved clip itself is excluded from the shift, then placed at `track`.
        const shifted =
          place.kind === "insert" ? openInsertSlot(st.clips, place.level, id) : st.clips;
        return placedState(
          st,
          shifted.map((c) =>
            c.id === id
              ? { ...c, track, start: at }
              : move.has(c.id)
                ? { ...c, start: move.get(c.id)! }
                : c
          ),
          id
        );
      });
    },

    detachAudio: () => {
      const { clips, assets, selection } = get();
      if (selection?.kind !== "clip") return;
      const clip = clips.find((c) => c.id === selection.id);
      if (!clip || clip.muted) return; // no sound to detach
      const span = clipWindow(clips, assets, clip.id);
      if (!span) return;
      push();
      const audio: AudioClip = {
        id: uid(),
        assetId: clip.assetId,
        start: span.start,
        in: clip.in,
        out: clip.out,
        volume: 1,
        // Carry the clip's rate so the detached track keeps the muted picture's
        // length and stays in sync (an AudioClip plays at its own `speed`).
        ...(clipSpeed(clip) !== 1 ? { speed: clipSpeed(clip) } : {}),
      };
      set((s) => ({
        audioClips: [...s.audioClips, audio],
        clips: s.clips.map((c) => (c.id === clip.id ? { ...c, muted: true } : c)),
        ...sole({ kind: "audio", id: audio.id }),
      }));
    },

    splitAtPlayhead: (at) => {
      const { clips, audioClips, assets, selection } = get();
      const t = at ?? playheadAt();

      // With a soundtrack clip selected, ⌘B slices it instead.
      if (selection?.kind === "audio") {
        const a = audioClips.find((c) => c.id === selection.id);
        const len = a ? clipLen(a) : 0;
        if (a && t > a.start + 0.05 && t < a.start + len - 0.05) {
          push();
          const cutIn = a.in + (t - a.start);
          const left: AudioClip = { ...a, out: cutIn };
          const right: AudioClip = { ...a, id: uid(), start: t, in: cutIn };
          set((s) => {
            const idx = s.audioClips.findIndex((c) => c.id === a.id);
            const next = [...s.audioClips];
            next.splice(idx, 1, left, right);
            return { audioClips: next, ...sole({ kind: "audio", id: right.id }) };
          });
          return;
        }
      }

      // A layer clip (off track 0) selected: slice it in place. A track-0
      // clip falls through to the playhead-driven span split below.
      if (selection?.kind === "clip") {
        const c = get().clips.find((x) => x.id === selection.id);
        if (c && c.track !== 0) {
          const sp = c.speed && c.speed > 0 ? c.speed : 1;
          const eff = (c.out - c.in) / sp;
          if (t > c.start + 0.05 && t < c.start + eff - 0.05) {
            push();
            const cutIn = c.in + (t - c.start) * sp;
            // The left half hard-cuts into the right; the right keeps the
            // original dissolve into whatever came after (same as track 0).
            // The cut lands mid-footage, so the edges it creates stay plain:
            // the exit animation belongs to the right half's tail and the
            // entrance to the left half's head.
            const left: VideoClip = { ...c, out: cutIn, transition: undefined, transitionStyle: undefined, animOut: undefined };
            const right: VideoClip = { ...c, id: uid(), start: t, in: cutIn, animIn: undefined };
            set((s) => {
              const idx = s.clips.findIndex((x) => x.id === c.id);
              const next = [...s.clips];
              next.splice(idx, 1, left, right);
              return { clips: next, ...sole({ kind: "clip", id: right.id }) };
            });
          }
          return;
        }
      }

      // An overlay element selected: both halves keep the full content/style.
      if (selection?.kind === "overlay") {
        const o = get().overlays.find((x) => x.id === selection.id);
        if (o && t > o.start + 0.05 && t < o.end - 0.05) {
          push();
          const left: Overlay = { ...o, end: t };
          const right: Overlay = { ...o, id: uid(), start: t };
          set((s) => ({
            overlays: s.overlays.flatMap((x) => (x.id === o.id ? [left, right] : [x])),
            ...sole({ kind: "overlay", id: right.id }),
          }));
        }
        return;
      }

      // A caption selected: word timings are absolute, so each half keeps the
      // words it covers and its text follows them; without timings the text
      // splits proportionally.
      if (selection?.kind === "cue") {
        const c = get().subtitles.cues.find((x) => x.id === selection.id);
        if (c && t > c.start + 0.05 && t < c.end - 0.05) {
          push();
          const lw = c.words?.filter((w) => w.t0 < t);
          const rw = c.words?.filter((w) => w.t0 >= t);
          const at = Math.round(c.text.length * ((t - c.start) / (c.end - c.start)));
          const left: SubtitleCue = {
            ...c,
            end: t,
            text: lw?.length ? lw.map((w) => w.w).join(" ") : c.text.slice(0, at).trim() || c.text,
            words: lw?.length ? lw : undefined,
          };
          const right: SubtitleCue = {
            ...c,
            id: uid(),
            start: t,
            text: rw?.length ? rw.map((w) => w.w).join(" ") : c.text.slice(at).trim() || c.text,
            words: rw?.length ? rw : undefined,
          };
          set((s) => ({
            subtitles: {
              ...s.subtitles,
              cues: s.subtitles.cues.flatMap((x) => (x.id === c.id ? [left, right] : [x])),
            },
            ...sole({ kind: "cue", id: right.id }),
          }));
        }
        return;
      }

      const spans = getClipSpans(clips, assets);
      const span = spans.find(
        (sp) => t > sp.start + 0.05 && t < sp.start + sp.len - 0.05
      );
      if (!span) return;
      push();
      // Source time advances `speed`× faster than timeline time.
      const cutAt = span.clip.in + (t - span.start) * clipSpeed(span.clip);
      // The left half hard-cuts into the right; the right keeps the original
      // dissolve into whatever came after. Both halves stay in place. The cut
      // lands mid-footage, so the edges it creates stay plain: the exit
      // animation stays on the right half's tail, the entrance on the left's
      // head.
      const left: VideoClip = { ...span.clip, out: cutAt, transition: undefined, transitionStyle: undefined, animOut: undefined };
      const right: VideoClip = { ...span.clip, id: uid(), in: cutAt, start: t, animIn: undefined };
      set((s) => {
        const idx = s.clips.findIndex((c) => c.id === span.clip.id);
        const next = [...s.clips];
        next.splice(idx, 1, left, right);
        return { clips: next, ...sole({ kind: "clip", id: right.id }) };
      });
    },

    deleteSelection: () => {
      const st = get();
      // A picked keyframe is the smaller thing under the cursor: Delete takes
      // the key and leaves the item it belongs to alone.
      const key = st.selectedKey;
      if (key) {
        set({ selectedKey: null });
        const item =
          key.kind === "overlay"
            ? st.overlays.find((x) => x.id === key.id)
            : st.clips.find((x) => x.id === key.id);
        const keys = key.track === "mask" ? item?.mask?.kf : item?.kf;
        if (keys?.some((k) => Math.abs(k.t - key.t) <= KEY_EPSILON)) {
          if (key.kind === "overlay") {
            if (key.track === "mask") st.removeOverlayMaskKey(key.id, key.t);
            else st.removeOverlayKey(key.id, key.t);
          } else if (key.track === "mask") st.removeClipMaskKey(key.id, key.t);
          else st.removeClipKey(key.id, key.t);
          return;
        }
      }
      const sels = st.multiSelection.length
        ? st.multiSelection
        : st.selection
          ? [st.selection]
          : [];
      if (sels.length === 0) return;
      push();
      const idsOf = (k: NonNullable<Selection>["kind"]) =>
        new Set(
          sels
            .filter((x): x is NonNullable<Selection> => !!x && x.kind === k)
            .map((x) => x.id)
        );
      const clipIds = idsOf("clip");
      const audioIds = idsOf("audio");
      const textIds = idsOf("overlay");
      const cueIds = idsOf("cue");
      const barIds = idsOf("transition");
      set((s) => {
        let clips = s.clips.filter((c) => !clipIds.has(c.id));
        let audioClips = s.audioClips.filter((c) => !audioIds.has(c.id));
        let overlays = s.overlays.filter((o) => !textIds.has(o.id));
        let cues = s.subtitles.cues.filter((c) => !cueIds.has(c.id));
        // Deleting a track-0 clip closes the hole it leaves: everything after
        // it — clips, titles, captions, soundtrack — slides left with the
        // surviving footage, and anything living inside the hole annotated
        // footage that is gone, so it goes too. Two conditions gate that
        // ripple. Track 0 has to be the only video track, since with upper
        // layers surviving the slide would shear them against the footage they
        // were composed over. And some track-0 footage has to survive the
        // delete: clearing the whole track leaves no hole to close, and closing
        // it anyway would carry every title, card and caption in the project
        // into the excision. Either way the delete leaves the gap and closing
        // it is an explicit act (removeGap, via right-click on the empty
        // space). Deletes on every other track are plain removals (already
        // applied above). Holes close right-to-left so each one's coordinates
        // stay valid while the ones before it are unprocessed.
        const rippling = clips.some((c) => c.track === 0) && !clips.some((c) => c.track !== 0);
        const holes = rippling
          ? s.clips
              .filter((c) => c.track === 0 && clipIds.has(c.id))
              .sort((a, b) => b.start - a.start)
          : [];
        for (const gone of holes) {
          const next = clips.reduce(
            (acc, c) => (c.track === 0 && c.start > gone.start + 0.001 ? Math.min(acc, c.start) : acc),
            Infinity
          );
          // The clip's own footprint, capped at the next clip's start so a
          // dissolve overlap (or a neighbor dragged into it) never over-closes;
          // any gap that already existed after it survives.
          const delta = Math.min(clipLen(gone), next - gone.start);
          if (delta < 0.05) continue;
          ({ clips, audioClips, overlays, cues } = exciseRange(
            { clips, audioClips, overlays, cues },
            gone.start,
            delta
          ));
        }
        clips = clips.sort((a, b) => a.start - b.start);
        // A blend playing a deleted clip's own edge goes with the clip; the
        // rest ride the ripple to wherever their cut ended up.
        const roles = s.transitions.length
          ? resolveTransitions(s.clips, s.transitions)
          : new Map<string, TransitionRole[]>();
        // A deleted clip's edges take their parked bars along: a bar aligned
        // with the clip's head or tail that lost its boundary claim (a twin)
        // is this clip's leftover, and it would otherwise sit on the row as
        // an orphan forever. A playing bar goes when every clip it plays is
        // going; one still serving a surviving track's boundary stays.
        const edges: number[] = [];
        for (const c of s.clips) {
          if (!clipIds.has(c.id)) continue;
          edges.push(c.start, c.start + clipLen(c));
        }
        const onEdge = (x: number) => edges.some((e) => Math.abs(e - x) <= TOUCH_EPS);
        const dropped = (t: TimelineTransition) => {
          if (barIds.has(t.id)) return true;
          const rs = roles.get(t.id);
          if (rs && rs.length > 0) return rs.every((r) => clipIds.has(r.clipId));
          return onEdge(t.start) || onEdge(t.start + t.seconds);
        };
        const kept = s.transitions.some(dropped)
          ? s.transitions.filter((t) => !dropped(t))
          : s.transitions;
        const transitions = reanchorTransitions(s.clips, clips, kept);
        return {
          clips,
          ...(transitions !== s.transitions ? { transitions } : {}),
          audioClips,
          overlays,
          subtitles: { ...s.subtitles, cues },
          selection: null,
          multiSelection: [],
        };
      });
    },

    removeLaneGap: (lane, at) => {
      const gap = laneGapAt(get(), lane, at);
      if (!gap) return;
      push();
      const after = gap.start + gap.len - 0.001;
      const shift = gap.len;
      set((s) => {
        if (lane.kind === "video") {
          const clips = s.clips
            .map((c) =>
              c.track === lane.index && c.start >= after ? { ...c, start: c.start - shift } : c
            )
            .sort((a, b) => a.start - b.start);
          return { clips, transitions: reanchorTransitions(s.clips, clips, s.transitions) };
        }
        if (lane.kind === "audio")
          return {
            audioClips: s.audioClips
              .map((a) =>
                (a.lane ?? 0) === lane.index && a.start >= after
                  ? { ...a, start: a.start - shift }
                  : a
              )
              .sort((a, b) => a.start - b.start),
          };
        return {
          overlays: s.overlays
            .map((o) =>
              (o.lane ?? 0) === lane.index && o.start >= after
                ? { ...o, start: o.start - shift, end: o.end - shift }
                : o
            )
            .sort((a, b) => a.start - b.start),
        };
      });
    },

    selectionRange: () => {
      const s = get();
      const sels = (s.multiSelection.length ? s.multiSelection : s.selection ? [s.selection] : [])
        .filter((x): x is NonNullable<Selection> => !!x);
      if (sels.length === 0) return null;
      const spans = getClipSpans(s.clips, s.assets);
      let start = Infinity;
      let end = -Infinity;
      const add = (a: number, b: number) => {
        start = Math.min(start, a);
        end = Math.max(end, b);
      };
      for (const sel of sels) {
        if (sel.kind === "clip") {
          const sp = spans.find((x) => x.clip.id === sel.id);
          if (sp) {
            add(sp.start, sp.start + sp.len);
          } else {
            // A layer clip carries no span (spans are track 0); use its
            // own footprint.
            const c = s.clips.find((x) => x.id === sel.id);
            if (c) {
              const speed = c.speed && c.speed > 0 ? c.speed : 1;
              add(c.start, c.start + Math.max(0.1, (c.out - c.in) / speed));
            }
          }
        } else if (sel.kind === "audio") {
          const c = s.audioClips.find((x) => x.id === sel.id);
          if (c) add(c.start, c.start + clipLen(c));
        } else if (sel.kind === "overlay") {
          const o = s.overlays.find((x) => x.id === sel.id);
          if (o) add(o.start, o.end);
        } else if (sel.kind === "cue") {
          const c = s.subtitles.cues.find((x) => x.id === sel.id);
          if (c) add(c.start, c.end);
        }
      }
      return Number.isFinite(start) && end > start ? { start, end } : null;
    },

    selectionTemplate: () => {
      const s = get();
      const sels = (s.multiSelection.length ? s.multiSelection : s.selection ? [s.selection] : [])
        .filter((x): x is NonNullable<Selection> => !!x);
      if (sels.length === 0) return null;
      const range = get().selectionRange();
      const start0 = range ? range.start : 0;
      const spans = getClipSpans(s.clips, s.assets);

      // Media is referenced by array index; each source is listed once.
      const media: TemplateMedia[] = [];
      const indexByAsset = new Map<string, number>();
      const mediaFor = (assetId: string): number | null => {
        const cached = indexByAsset.get(assetId);
        if (cached != null) return cached;
        const a = s.assets.find((x) => x.id === assetId);
        if (!a) return null;
        const i = media.length;
        media.push({ fileName: a.fileName, name: a.name, type: a.type, duration: a.duration, width: a.width, height: a.height });
        indexByAsset.set(assetId, i);
        return i;
      };

      const layers: TemplateLayer[] = [];
      const audio: TemplateAudio[] = [];
      const texts: Overlay[] = [];
      const cues: SubtitleCue[] = [];
      for (const sel of sels) {
        if (sel.kind === "clip") {
          const sp = spans.find((x) => x.clip.id === sel.id);
          if (sp) {
            const mi = mediaFor(sp.clip.assetId);
            if (mi == null) continue;
            // Track-0 clips re-materialize onto track 0 (asClip), so a template
            // stands up its own video instead of an empty timeline.
            layers.push({ media: mi, start: sp.start - start0, in: sp.clip.in, out: sp.clip.out, ...framingOf(sp.clip), muted: sp.clip.muted, speed: sp.clip.speed, track: 1, asClip: true });
          } else {
            const c = s.clips.find((x) => x.id === sel.id);
            if (!c) continue;
            const mi = mediaFor(c.assetId);
            if (mi == null) continue;
            layers.push({ media: mi, start: c.start - start0, in: c.in, out: c.out, ...framingOf(c), muted: c.muted, speed: c.speed, track: c.track + 1 });
          }
        } else if (sel.kind === "audio") {
          const c = s.audioClips.find((x) => x.id === sel.id);
          if (!c) continue;
          const mi = mediaFor(c.assetId);
          if (mi == null) continue;
          audio.push({ media: mi, start: c.start - start0, in: c.in, out: c.out, volume: c.volume, fadeIn: c.fadeIn, fadeOut: c.fadeOut, speed: c.speed, duck: c.duck, lane: c.lane });
        } else if (sel.kind === "overlay") {
          const o = s.overlays.find((x) => x.id === sel.id);
          // Asset-backed stickers stay out: a template copies only the media
          // its layers/audio reference, so the sticker's bytes wouldn't travel.
          if (o && !(isStickerOverlay(o) && o.assetId)) {
            texts.push({ ...o, start: o.start - start0, end: o.end - start0 });
          }
        } else if (sel.kind === "cue") {
          const c = s.subtitles.cues.find((x) => x.id === sel.id);
          if (c) cues.push({ ...c, start: c.start - start0, end: c.end - start0 });
        }
      }
      if (media.length === 0 && texts.length === 0 && cues.length === 0) return null;
      const duration = range
        ? range.end - range.start
        : Math.max(0.1, ...texts.map((t) => t.end), ...cues.map((c) => c.end));
      return { name: "Template", duration, media, layers, audio, texts, cues };
    },

    addTemplate: (input) => {
      const t: LibraryTemplate = { id: uid(), addedAt: Date.now(), ...input };
      set({ templates: [t, ...get().templates] });
      return t;
    },

    renameTemplate: (id, name) =>
      set({
        templates: get().templates.map((t) => (t.id === id ? { ...t, name } : t)),
      }),

    removeTemplate: (id) => set({ templates: get().templates.filter((t) => t.id !== id) }),

    addAssetToTemplate: (templateId, assetId) => {
      const s = get();
      const t = s.templates.find((x) => x.id === templateId);
      const a = s.assets.find((x) => x.id === assetId);
      if (!t || !a) return;
      // Reuse the media entry when the template already references this file.
      const existing = t.media.findIndex((m) => m.fileName === a.fileName);
      const media =
        existing >= 0
          ? t.media
          : [
              ...t.media,
              { fileName: a.fileName, name: a.name, type: a.type, duration: a.duration, width: a.width, height: a.height },
            ];
      const mi = existing >= 0 ? existing : media.length - 1;
      const len = a.type === "image" ? IMAGE_CLIP_SECONDS : a.duration;
      const updated: LibraryTemplate =
        a.type === "audio"
          ? {
              ...t,
              media,
              duration: t.duration + len,
              audio: [...t.audio, { media: mi, start: t.duration, in: 0, out: len, volume: 1 }],
            }
          : {
              ...t,
              media,
              duration: t.duration + len,
              layers: [
                ...t.layers,
                { media: mi, start: t.duration, in: 0, out: len, muted: false, track: 1, asClip: true },
              ],
            };
      set({ templates: s.templates.map((x) => (x.id === templateId ? updated : x)) });
    },

    insertTemplate: (template, assetIds, offset) => {
      push();
      const usable = template.layers.filter((l) => assetIds[l.media]);
      // Templates saved by older builds persisted `onBase`;
      // read it as asClip so their footage still lands on track 0.
      const isClip = (l: (typeof usable)[number]) =>
        l.asClip ?? (l as { onBase?: boolean }).onBase;
      const clipLayers = usable.filter((l) => isClip(l));
      const overlayLayerDefs = usable.filter((l) => !isClip(l));
      // Clip layers append at the end of the current track 0; the
      // free-positioned parts (overlays, audio, captions) shift to line up with
      // that segment. A template with no clip layers drops in at the playhead.
      const shift = clipLayers.length ? totalDuration(get().clips) : Math.max(0, offset);
      const newClips: VideoClip[] = [...clipLayers]
        .sort((a, b) => a.start - b.start)
        .map((l) => ({
          track: 0,
          start: l.start + shift,
          id: uid(),
          assetId: assetIds[l.media],
          in: l.in,
          out: l.out,
          muted: l.muted,
          ...templateFraming(l),
          ...(l.speed ? { speed: l.speed } : {}),
        }));
      const topTrack = Math.max(0, ...overlayLayers(get().clips).map((c) => c.track));
      // Template layers store `track` as the source track + 1 (so a track-1
      // layer saved as 2). Layers stack on top of the project's current top —
      // never onto track 0 itself, which would splice them into the transition
      // sequence. Templates saved when tracks could go negative (backdrops)
      // clamp into the stack above too.
      const newLayers: VideoClip[] = overlayLayerDefs.map((l) => ({
        id: uid(),
        assetId: assetIds[l.media],
        track: topTrack + Math.max(1, l.track),
        start: l.start + shift,
        in: l.in,
        out: l.out,
        muted: l.muted,
        ...templateFraming(l),
        ...(l.speed ? { speed: l.speed } : {}),
      }));
      const newAudio: AudioClip[] = template.audio
        .filter((a) => assetIds[a.media])
        .map((a) => ({
          id: uid(),
          assetId: assetIds[a.media],
          start: a.start + shift,
          in: a.in,
          out: a.out,
          volume: a.volume,
          ...(a.fadeIn ? { fadeIn: a.fadeIn } : {}),
          ...(a.fadeOut ? { fadeOut: a.fadeOut } : {}),
          ...(a.speed ? { speed: a.speed } : {}),
          ...(a.duck !== undefined && a.duck < 1 ? { duck: a.duck } : {}),
          ...(a.lane ? { lane: a.lane } : {}),
        }));
      // Templates saved before the union carry bare titles — same stamp,
      // behind-speaker migration, and move-track lift as the doc loader, so
      // every in-memory element has its discriminant, one mask model, and its
      // move in the slot. Groups are remapped per application, so adding the
      // same template twice gives two independent groups.
      const regroup = groupRemap(uid);
      const newTexts: Overlay[] = liftMoveTracks(
        migrateBehindSubject(stampOverlayKinds(template.texts))
      ).map((o) => ({
        ...o,
        id: uid(),
        start: o.start + shift,
        end: o.end + shift,
        ...regroup(o),
      }));
      const newCues: SubtitleCue[] = template.cues.map((c) => ({
        ...c,
        id: uid(),
        start: c.start + shift,
        end: c.end + shift,
      }));
      set((s) => ({
        clips: [...s.clips, ...newClips, ...newLayers].sort((a, b) => a.start - b.start),
        audioClips: [...s.audioClips, ...newAudio],
        overlays: [...s.overlays, ...newTexts],
        subtitles: {
          ...s.subtitles,
          cues: [...s.subtitles.cues, ...newCues].sort((a, b) => a.start - b.start),
        },
      }));
    },

    select: (sel) => {
      // Selecting one member of a group selects the whole group (shallow, by
      // design): bulk actions — delete, copy, drag — act on all of it, while
      // the clicked member stays the primary the inspector edits.
      if (sel?.kind === "overlay") {
        const o = get().overlays.find((x) => x.id === sel.id);
        if (o?.groupId) {
          const members = get()
            .overlays.filter((x) => x.groupId === o.groupId)
            .map((x): NonNullable<Selection> => ({ kind: "overlay", id: x.id }));
          set({ selection: sel, multiSelection: members, selectedKey: null });
          return;
        }
      }
      set({ selection: sel, multiSelection: sel ? [sel] : [], selectedKey: null });
    },

    groupSelectedOverlays: () => {
      const s = get();
      const ids = s.multiSelection
        .filter((x): x is NonNullable<Selection> => !!x && x.kind === "overlay")
        .map((x) => x.id);
      if (ids.length < 2) return;
      push();
      const groupId = uid();
      get().updateOverlaysTransient(ids.map((id) => ({ id, patch: { groupId } })));
    },

    ungroupOverlays: (groupId) => {
      const members = get().overlays.filter((o) => o.groupId === groupId);
      if (members.length === 0) return;
      push();
      get().updateOverlaysTransient(members.map((o) => ({ id: o.id, patch: { groupId: undefined } })));
    },

    toggleSelect: (sel) =>
      set((s) => {
        const has = s.multiSelection.some((x) => x?.kind === sel.kind && x.id === sel.id);
        const next = has
          ? s.multiSelection.filter((x) => !(x?.kind === sel.kind && x.id === sel.id))
          : [...s.multiSelection, sel];
        // Primary is the just-added item, or the last survivor when removing.
        const primary = has ? next[next.length - 1] ?? null : sel;
        return { multiSelection: next, selection: primary };
      }),

    setMultiSelection: (sels) =>
      set({
        multiSelection: sels,
        selection: sels[sels.length - 1] ?? null,
        selectedKey: null,
      }),

    seek: (t) => {
      const total = projectDuration(get());
      setPlayhead(Math.max(0, Math.min(total, t)));
      // A manual seek cancels any scoped effect preview.
      if (get().previewStopAt !== null) set({ previewStopAt: null });
    },

    // A manual play/pause cancels any scoped effect preview. Starting playback
    // also drops the skimmer: the picture belongs to the playhead again, and a
    // pointer left standing over the timeline would otherwise keep claiming it.
    setPlaying: (p) => {
      if (p) setSkim(null);
      set({ playing: p, previewStopAt: null });
    },

    previewRange: (start, end) => {
      const total = projectDuration(get());
      const from = Math.max(0, Math.min(total, start));
      const to = Math.max(from + 0.05, Math.min(total, end));
      setPlayhead(from);
      // Starting playback drops the skimmer, same as setPlaying: while the
      // cut plays, the playhead owns the picture everywhere — a skim left
      // standing would freeze the DOM surfaces on one frame while the canvas
      // runs.
      setSkim(null);
      set({ playing: true, previewStopAt: to });
    },
    setPublish: (patch) => set((s) => ({ publish: { ...s.publish, ...patch } })),
    setNotes: (patch) => set((s) => ({ notes: { ...s.notes, ...patch } })),

    cutMixSamples: async () => {
      const s = get();
      if (!s.projectId) return null;
      const spec = cutTranscribeSpec(s);
      if (!spec) return null;
      const mix = await renderMix(s.projectId, spec);
      if (!mix) return null;
      return { samples: mix.getChannelData(0), sampleRate: mix.sampleRate };
    },

    generateSubtitles: async () => {
      const s = get();
      if (!s.projectId || s.subtitleStatus === "running") return;
      const projectId = s.projectId;
      // Generation targets the active subtitle track, with its own language.
      const lane = s.subtitleLane;
      const spec = cutTranscribeSpec(s, trackLocale(s.subtitles, lane));
      if (!spec) {
        set({ subtitleStatus: "error", subtitleError: "Add a video to the timeline first." });
        return;
      }
      const epoch = laneEpoch;
      set({ subtitleStatus: "running", subtitleError: null, subtitleStartedAt: Date.now() });
      try {
        const cues = await runTranscription(projectId, spec);
        if (cues === null) return; // switched projects mid-run
        if (laneEpoch !== epoch) return set(staleLaneError);
        // Only the active track's cues are replaced; other languages stay.
        const tagged = cues.map((c) => ({ ...c, ...(lane > 0 ? { lane } : {}) }));
        if (cues.length === 0) {
          // No speech in the audio — leave the other tracks untouched. This
          // still deletes the active track's cues (possibly hand-edited), so
          // it checkpoints like the replace path: ⌘Z brings them back.
          if (get().subtitles.cues.some((c) => (c.lane ?? 0) === lane)) push();
          set((cur) => ({
            subtitles: {
              ...cur.subtitles,
              cues: cur.subtitles.cues.filter((c) => (c.lane ?? 0) !== lane),
              generatedAt: Date.now(),
            },
            subtitleStatus: "empty",
          }));
          return;
        }
        push();
        set((cur) => ({
          subtitles: {
            ...cur.subtitles,
            cues: [
              ...cur.subtitles.cues.filter((c) => (c.lane ?? 0) !== lane),
              ...tagged,
            ].sort((a, b) => a.start - b.start),
            generatedAt: Date.now(),
          },
          subtitleStatus: "ready",
        }));
      } catch (err) {
        if (get().projectId !== projectId) return;
        set({
          subtitleStatus: "error",
          subtitleError: err instanceof Error ? err.message : String(err),
        });
      }
    },

    generateClipSubtitles: async (clipId) => {
      const s = get();
      if (!s.projectId) throw new Error("Open a project first.");
      if (s.subtitleStatus === "running") {
        throw new Error("Subtitles are already generating — try again in a moment.");
      }
      const projectId = s.projectId;
      const sp = clipWindow(s.clips, s.assets, clipId);
      if (!sp) throw new Error("The clip is no longer on the timeline.");
      const lane = s.subtitleLane;
      const epoch = laneEpoch;
      // The clip's own sound, deliberately unmuted: this transcribes what the
      // clip says even when its timeline audio is muted.
      const spec = {
        duration: sp.len,
        locale: trackLocale(s.subtitles, lane),
        clips: [
          {
            file: sp.asset.fileName,
            in: sp.clip.in,
            out: sp.clip.out,
            muted: false,
            speed: clipSpeed(sp.clip),
            transition: 0,
          },
        ],
        audio: [],
      };
      set({ subtitleStatus: "running", subtitleError: null, subtitleStartedAt: Date.now() });
      try {
        const cues = await runTranscription(projectId, spec);
        if (cues === null) return; // switched projects mid-run
        if (laneEpoch !== epoch) {
          set(staleLaneError);
          throw new Error(staleLaneError.subtitleError);
        }
        // The job timed cues against the lone clip, so shift them (and their
        // word timings) onto the clip's timeline span. New cues replace any
        // on the active track that overlapped the clip; the rest of the
        // timeline — and every other track — keeps its cues.
        const placed = cues.map((c) => ({
          ...c,
          start: c.start + sp.start,
          end: c.end + sp.start,
          words: c.words?.map((w) => ({ ...w, t0: w.t0 + sp.start, t1: w.t1 + sp.start })),
          ...(lane > 0 ? { lane } : {}),
        }));
        if (placed.length > 0) push();
        set((cur) => {
          const kept = cur.subtitles.cues.filter(
            (c) =>
              (c.lane ?? 0) !== lane || !(c.end > sp.start && c.start < sp.start + sp.len)
          );
          const merged = [...kept, ...placed].sort((a, b) => a.start - b.start);
          return {
            subtitles: { ...cur.subtitles, cues: merged, generatedAt: Date.now() },
            subtitleStatus: merged.length > 0 ? "ready" : "empty",
          };
        });
      } catch (err) {
        // The clip panel reports the error; just clear the global busy flag.
        if (get().projectId === projectId) {
          set({ subtitleStatus: get().subtitles.cues.length > 0 ? "ready" : "idle" });
        }
        throw err;
      }
    },

    generateVisualSubtitles: async () => {
      const s = get();
      if (!s.projectId || s.subtitleStatus === "running") return;
      if (!getBackend().caps.captionAi) {
        set({ subtitleStatus: "error", subtitleError: "Not available in cloud mode yet." });
        return;
      }
      const projectId = s.projectId;
      const spans = getClipSpans(s.clips, s.assets);
      if (spans.length === 0) {
        set({ subtitleStatus: "error", subtitleError: "Add a video to the timeline first." });
        return;
      }
      const duration = totalDuration(s.clips);
      const lane = s.subtitleLane;
      const epoch = laneEpoch;
      set({ subtitleStatus: "running", subtitleError: null, subtitleStartedAt: Date.now() });
      try {
        const frames = await captureTimelineFrames(spans);
        if (frames.length === 0) throw new Error("Could not read any frames from the cut.");
        const res = await apiFetch("/api/cut/ai/visual-subtitles", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            frames,
            duration,
            locale: trackLocale(s.subtitles, lane),
          }),
        });
        const body = await apiJson<{
          cues?: { start: number; end: number; text: string }[];
        }>(res);
        if (!res.ok || !Array.isArray(body.cues)) {
          throw new Error(body.error ?? "Captioning failed.");
        }
        if (get().projectId !== projectId) return; // switched projects mid-run
        if (laneEpoch !== epoch) return set(staleLaneError);
        const cues: SubtitleCue[] = body.cues.map((c) => ({
          id: uid(),
          start: c.start,
          end: c.end,
          text: c.text,
          ...(lane > 0 ? { lane } : {}),
        }));
        push();
        set((cur) => ({
          subtitles: {
            ...cur.subtitles,
            cues: [
              ...cur.subtitles.cues.filter((c) => (c.lane ?? 0) !== lane),
              ...cues,
            ].sort((a, b) => a.start - b.start),
            generatedAt: Date.now(),
          },
          subtitleStatus: cues.length > 0 ? "ready" : "empty",
        }));
      } catch (err) {
        if (get().projectId !== projectId) return;
        set({
          subtitleStatus: "error",
          subtitleError: err instanceof Error ? err.message : String(err),
        });
      }
    },

    generateCaptions: async (style) => {
      const s = get();
      if (!s.projectId || s.subtitleStatus === "running") return;
      if (!getBackend().caps.captionAi) {
        set({ subtitleStatus: "error", subtitleError: "Not available in cloud mode yet." });
        return;
      }
      const lane = s.subtitleLane;
      const laneOf = (c: SubtitleCue) => c.lane ?? 0;
      // Need cues first — transcribe if the active track hasn't been captioned.
      if (!s.subtitles.cues.some((c) => laneOf(c) === lane)) {
        await s.generateSubtitles();
        if (!get().subtitles.cues.some((c) => laneOf(c) === lane)) return; // no speech, or an error
      }
      const projectId = get().projectId;
      // Apply the look right away for instant feedback, then rewrite the text.
      set((cur) => ({
        subtitles: { ...cur.subtitles, style },
        subtitleStatus: "running",
        subtitleError: null,
        subtitleStartedAt: Date.now(),
      }));
      // Rewrite only the active track — other languages keep their text.
      const cues = get().subtitles.cues.filter((c) => laneOf(c) === lane);
      try {
        const res = await apiFetch("/api/cut/ai/captions", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            style,
            cues: cues.map((c) => ({ start: c.start, end: c.end, text: c.text })),
          }),
        });
        const body = await apiJson<{ texts?: string[] }>(res);
        if (get().projectId !== projectId) return;
        push();
        if (res.ok && Array.isArray(body.texts) && body.texts.length === cues.length) {
          // Key the rewrite to the cue ids it was generated from, so an edit
          // that reordered/split cues mid-request can't apply text by a stale
          // index onto the wrong cue.
          const byId = new Map(cues.map((c, i) => [c.id, body.texts![i]]));
          set((cur) => ({
            subtitles: {
              ...cur.subtitles,
              style,
              // Rewriting the text drops per-word timings (they no longer match),
              // but the cue's own start/end are untouched.
              cues: cur.subtitles.cues.map((c) => {
                const t = byId.get(c.id);
                return t && t !== c.text ? { ...c, text: t, words: undefined } : c;
              }),
            },
            subtitleStatus: "ready",
          }));
        } else {
          // The style still applied; leave the text as-is.
          set({ subtitleStatus: "ready" });
        }
      } catch (err) {
        if (get().projectId !== projectId) return;
        set({
          subtitleStatus: "ready",
          subtitleError: err instanceof Error ? err.message : String(err),
        });
      }
    },

    translateSubtitleTrack: async (fromLane) => {
      const s = get();
      const lane = s.subtitleLane;
      if (!s.projectId || s.subtitleStatus === "running" || fromLane === lane) return;
      if (!getBackend().caps.captionAi) {
        set({ subtitleStatus: "error", subtitleError: "Not available in cloud mode yet." });
        return;
      }
      const laneOf = (c: SubtitleCue) => c.lane ?? 0;
      const source = s.subtitles.cues.filter((c) => laneOf(c) === fromLane);
      if (source.length === 0) return;
      const locale = trackLocale(s.subtitles, lane);
      const projectId = s.projectId;
      const epoch = laneEpoch;
      set({ subtitleStatus: "running", subtitleError: null, subtitleStartedAt: Date.now() });
      try {
        const res = await apiFetch("/api/cut/ai/captions", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            translateTo: locale,
            cues: source.map((c) => ({ start: c.start, end: c.end, text: c.text })),
          }),
        });
        const body = await apiJson<{ texts?: string[]; error?: string }>(res);
        if (get().projectId !== projectId) return;
        if (!res.ok || !Array.isArray(body.texts) || body.texts.length !== source.length) {
          throw new Error(body.error || "Could not translate the captions.");
        }
        if (laneEpoch !== epoch) return set(staleLaneError);
        push();
        const texts = body.texts;
        set((cur) => ({
          subtitles: {
            ...cur.subtitles,
            cues: [
              ...cur.subtitles.cues.filter((c) => laneOf(c) !== lane),
              ...source.map((c, i) => ({
                id: uid(),
                start: c.start,
                end: c.end,
                text: texts[i],
                ...(lane > 0 ? { lane } : {}),
              })),
            ].sort((a, b) => a.start - b.start),
            generatedAt: Date.now(),
          },
          subtitleStatus: "ready",
        }));
      } catch (err) {
        if (get().projectId !== projectId) return;
        set({
          subtitleStatus: "error",
          subtitleError: err instanceof Error ? err.message : String(err),
        });
      }
    },

    setSubtitlesView: (patch) =>
      set((s) => ({ subtitles: { ...s.subtitles, ...patch } })),

    setSubtitleLane: (lane) => {
      const count = Math.max(
        1,
        get().subtitles.tracks?.length ?? 0,
        ...get().subtitles.cues.map((c) => (c.lane ?? 0) + 1)
      );
      set({ subtitleLane: Math.max(0, Math.min(count - 1, lane)) });
    },

    addSubtitleTrack: (locale) => {
      const s = get();
      const count = Math.max(
        1,
        s.subtitles.tracks?.length ?? 0,
        ...s.subtitles.cues.map((c) => (c.lane ?? 0) + 1)
      );
      if (count >= MAX_SUBTITLE_LANES) return;
      push();
      // Materialize metas up to the new track so indices stay aligned.
      const tracks: SubtitleTrackMeta[] = Array.from(
        { length: count + 1 },
        (_, i) => s.subtitles.tracks?.[i] ?? {}
      );
      tracks[count] = { ...(locale ? { locale } : {}) };
      set((cur) => ({
        subtitles: { ...cur.subtitles, tracks },
        subtitleLane: count,
      }));
    },

    removeSubtitleTrack: (lane) => {
      const s = get();
      const count = Math.max(
        1,
        s.subtitles.tracks?.length ?? 0,
        ...s.subtitles.cues.map((c) => (c.lane ?? 0) + 1)
      );
      if (count <= 1) {
        // The editor always keeps one subtitle lane, so removing the only
        // track empties it: cues, language, and dragged anchor all reset.
        if (s.subtitles.cues.length === 0) return;
        push();
        laneEpoch++; // invalidate in-flight lane-targeted work
        const keep = (sel: Selection) => !!sel && sel.kind !== "cue";
        set((cur) => {
          const multiSelection = cur.multiSelection.filter(keep);
          return {
            subtitles: {
              ...cur.subtitles,
              tracks: undefined,
              locale: undefined,
              x: undefined,
              y: undefined,
              cues: [],
            },
            subtitleLane: 0,
            multiSelection,
            selection: keep(cur.selection)
              ? cur.selection
              : multiSelection[multiSelection.length - 1] ?? null,
          };
        });
        return;
      }
      push();
      laneEpoch++; // lanes renumber: invalidate in-flight lane-targeted work
      const gone = new Set(
        s.subtitles.cues.filter((c) => (c.lane ?? 0) === lane).map((c) => c.id)
      );
      const keep = (sel: Selection) => !!sel && !(sel.kind === "cue" && gone.has(sel.id));
      set((cur) => {
        const tracks = Array.from(
          { length: count },
          (_, i) => cur.subtitles.tracks?.[i] ?? {}
        ).filter((_, i) => i !== lane);
        const multiSelection = cur.multiSelection.filter(keep);
        return {
          subtitles: {
            ...cur.subtitles,
            tracks,
            // The block-level legacy locale and dragged anchor described the
            // first track; when that track goes, they go with it — the
            // promoted track must not inherit the deleted one's language or
            // caption spot.
            ...(lane === 0 ? { locale: undefined, x: undefined, y: undefined } : {}),
            cues: cur.subtitles.cues
              .filter((c) => (c.lane ?? 0) !== lane)
              .map((c) => {
                const l = c.lane ?? 0;
                return l > lane ? { ...c, lane: l - 1 > 0 ? l - 1 : undefined } : c;
              }),
          },
          // The active lane follows its track: lanes above the removed one
          // shift down; removing the active one clamps into range.
          subtitleLane: Math.max(
            0,
            Math.min(count - 2, cur.subtitleLane > lane ? cur.subtitleLane - 1 : cur.subtitleLane)
          ),
          multiSelection,
          selection: keep(cur.selection)
            ? cur.selection
            : multiSelection[multiSelection.length - 1] ?? null,
        };
      });
    },

    setSubtitleTrackMeta: (lane, patch) =>
      set((s) => {
        const count = Math.max(
          1,
          s.subtitles.tracks?.length ?? 0,
          ...s.subtitles.cues.map((c) => (c.lane ?? 0) + 1),
          lane + 1
        );
        const tracks: SubtitleTrackMeta[] = Array.from(
          { length: count },
          (_, i) => s.subtitles.tracks?.[i] ?? {}
        );
        tracks[lane] = { ...tracks[lane], ...patch };
        return { subtitles: { ...s.subtitles, tracks } };
      }),

    setCueText: (id, text) => {
      const trimmed = text.replace(/\s+/g, " ").trim();
      const cue = get().subtitles.cues.find((c) => c.id === id);
      if (!cue || cue.text === trimmed) return;
      push();
      // A same-length edit (fixing a misheard word) keeps the real per-word
      // timings, just swapping the text; a word added/removed drops them and
      // falls back to proportional timing.
      const parts = trimmed.split(" ").filter(Boolean);
      const words =
        cue.words && cue.words.length === parts.length
          ? parts.map((w, i) => ({ ...cue.words![i], w }))
          : undefined;
      set((s) => ({
        subtitles: {
          ...s.subtitles,
          cues: trimmed
            ? s.subtitles.cues.map((c) => (c.id === id ? { ...c, text: trimmed, words } : c))
            : s.subtitles.cues.filter((c) => c.id !== id),
        },
      }));
    },

    splitCue: (id, charOffset) => {
      const s = get();
      const cue = s.subtitles.cues.find((c) => c.id === id);
      if (!cue) return;
      const before = cue.text.slice(0, charOffset).trim();
      const after = cue.text.slice(charOffset).trim();
      if (!before || !after) return;
      let leftEnd: number;
      let rightStart: number;
      let leftWords: SubtitleCue["words"];
      let rightWords: SubtitleCue["words"];
      if (cue.words && cue.words.length > 1) {
        // Word timings are intact: split on the word under the caret so both
        // halves keep real timestamps.
        let n = 0;
        let idx = cue.words.length - 1;
        for (let i = 0; i < cue.words.length; i++) {
          n += cue.words[i].w.length + 1;
          if (charOffset < n) {
            idx = Math.max(1, i + 1);
            break;
          }
        }
        leftWords = cue.words.slice(0, idx);
        rightWords = cue.words.slice(idx);
        if (rightWords.length === 0) return;
        leftEnd = leftWords[leftWords.length - 1].t1;
        rightStart = rightWords[0].t0;
      } else {
        const t = cue.start + (cue.end - cue.start) * (charOffset / Math.max(1, cue.text.length));
        leftEnd = rightStart = Math.round(t * 100) / 100;
      }
      push();
      const left: SubtitleCue = {
        ...cue,
        end: leftEnd,
        text: leftWords ? leftWords.map((w) => w.w).join(" ") : before,
        words: leftWords,
      };
      const right: SubtitleCue = {
        id: uid(),
        start: rightStart,
        end: cue.end,
        text: rightWords ? rightWords.map((w) => w.w).join(" ") : after,
        words: rightWords,
      };
      set((cur) => ({
        subtitles: {
          ...cur.subtitles,
          cues: cur.subtitles.cues.flatMap((c) => (c.id === id ? [left, right] : [c])),
        },
      }));
    },

    mergeCueIntoPrev: (id) => {
      const all = get().subtitles.cues;
      const cue = all.find((c) => c.id === id);
      if (!cue) return;
      // "Previous" means the previous cue on the same subtitle track.
      const cues = all
        .filter((c) => (c.lane ?? 0) === (cue.lane ?? 0))
        .sort((a, b) => a.start - b.start);
      const i = cues.findIndex((c) => c.id === id);
      if (i <= 0) return;
      push();
      const prev = cues[i - 1];
      const merged: SubtitleCue = {
        ...prev,
        end: Math.max(prev.end, cue.end),
        text: `${prev.text} ${cue.text}`.replace(/\s+/g, " ").trim(),
        words: prev.words && cue.words ? [...prev.words, ...cue.words] : undefined,
      };
      set((s) => ({
        subtitles: {
          ...s.subtitles,
          cues: s.subtitles.cues.flatMap((c) =>
            c.id === prev.id ? [merged] : c.id === id ? [] : [c]
          ),
        },
      }));
    },

    deleteCue: (id) => {
      if (!get().subtitles.cues.some((c) => c.id === id)) return;
      push();
      set((s) => ({
        subtitles: { ...s.subtitles, cues: s.subtitles.cues.filter((c) => c.id !== id) },
      }));
    },

    updateCueTransient: (id, patch) =>
      set((s) => ({
        subtitles: {
          ...s.subtitles,
          cues: s.subtitles.cues.map((c) => (c.id === id ? { ...c, ...patch } : c)),
        },
      })),

    retimeItems: ({ cues = [], overlays = [] }) => {
      if (cues.length === 0 && overlays.length === 0) return;
      const cueBy = new Map(cues.map((c) => [c.id, c]));
      const overlayBy = new Map(overlays.map((o) => [o.id, o]));
      push();
      set((s) => ({
        subtitles:
          cues.length === 0
            ? s.subtitles
            : {
                ...s.subtitles,
                cues: s.subtitles.cues
                  .map((c) => {
                    const next = cueBy.get(c.id);
                    if (!next) return c;
                    // The floor is applied before the end is measured against
                    // the start, so a negative time can never leave an item
                    // ending before it begins.
                    const start = Math.max(0, next.start);
                    return {
                      ...c,
                      start,
                      end: Math.max(start, next.end),
                      ...(next.words ? { words: next.words } : {}),
                    };
                  })
                  .sort((a, b) => a.start - b.start),
              },
        overlays:
          overlays.length === 0
            ? s.overlays
            : s.overlays.map((o) => {
                const next = overlayBy.get(o.id);
                if (!next) return o;
                const start = Math.max(0, next.start);
                return { ...o, start, end: Math.max(start, next.end) };
              }),
      }));
    },

    setLaneCues: (lane, cues) => {
      push();
      const made: SubtitleCue[] = cues
        .filter((c) => c.text.trim().length > 0 && c.end > c.start)
        .map((c) => ({
          id: uid(),
          start: Math.max(0, c.start),
          end: c.end,
          text: c.text.trim(),
          ...(c.words && c.words.length > 0 ? { words: c.words } : {}),
          ...(lane > 0 ? { lane } : {}),
        }));
      set((s) => ({
        subtitles: {
          ...s.subtitles,
          cues: [...s.subtitles.cues.filter((c) => (c.lane ?? 0) !== lane), ...made].sort(
            (a, b) => a.start - b.start
          ),
        },
        subtitleStatus: made.length > 0 ? "ready" : s.subtitleStatus,
      }));
    },

    setCueTiming: (id, start, end) => {
      const cue = get().subtitles.cues.find((c) => c.id === id);
      if (!cue) return;
      const len = Math.max(0.15, end - start);
      const taken = get()
        .subtitles.cues.filter((c) => c.id !== id && (c.lane ?? 0) === (cue.lane ?? 0))
        .map((c) => ({ start: c.start, end: c.end }));
      const at = nextFreeStart(taken, Math.max(0, start), len);
      push();
      get().updateCueTransient(id, { start: at, end: at + len, words: undefined });
      get().sortCues();
    },

    retimeCues: (entries) => {
      if (entries.length === 0) return;
      const byId = new Map(entries.map((e) => [e.id, e]));
      if (!get().subtitles.cues.some((c) => byId.has(c.id))) return;
      push();
      set((s) => ({
        subtitles: {
          ...s.subtitles,
          cues: s.subtitles.cues.map((c) => {
            const e = byId.get(c.id);
            if (!e) return c;
            const start = e.start;
            const end = Math.max(start + 0.05, e.end);
            return { ...c, start, end, words: spreadWordsEvenly(c.text, start, end) };
          }),
        },
      }));
    },

    sortCues: () =>
      set((s) => ({
        subtitles: {
          ...s.subtitles,
          cues: [...s.subtitles.cues].sort((a, b) => a.start - b.start),
        },
      })),
    setPxPerSec: (v) => {
      const pxPerSec = clampPps(v);
      set({ pxPerSec });
      const id = get().projectId;
      if (id) saveUiState(id, { pxPerSec: Math.round(pxPerSec * 100) / 100 });
    },
    setTimelineH: (h) => {
      const timelineH = Math.round(Math.max(TIMELINE_H_MIN, Math.min(timelineHMax(), h)));
      set({ timelineH });
      const id = get().projectId;
      if (id) saveUiState(id, { timelineH });
    },
    setExportOpen: (v) => set({ exportOpen: v }),
    setDropActive: (v) => set({ dropActive: v }),
    setAiOpen: (v) => {
      set({ aiOpen: v });
      try {
        localStorage.setItem("cut-ai-open", v ? "1" : "0");
      } catch {
        // View preference only.
      }
    },

    copySelection: () => {
      const s = get();
      const sels = s.multiSelection.length ? s.multiSelection : s.selection ? [s.selection] : [];
      const items: ClipboardItem[] = [];
      for (const sel of sels) {
        if (sel?.kind === "clip") {
          const c = s.clips.find((x) => x.id === sel.id);
          if (c) items.push({ kind: "clip", item: { ...c } });
        } else if (sel?.kind === "audio") {
          const a = s.audioClips.find((x) => x.id === sel.id);
          if (a) items.push({ kind: "audio", item: { ...a } });
        } else if (sel?.kind === "overlay") {
          const o = s.overlays.find((x) => x.id === sel.id);
          if (o) items.push({ kind: "overlay", item: { ...o } });
        } else if (sel?.kind === "transition") {
          const t = s.transitions.find((x) => x.id === sel.id);
          if (t) items.push({ kind: "transition", item: { ...t } });
        }
      }
      if (items.length === 0) return false;
      clipboard = items;
      return true;
    },

    clearClipboard: () => {
      clipboard = [];
    },

    paste: () => {
      if (clipboard.length === 0) return false;
      const s = get();
      // Every copied item's media must still exist in this project (asset
      // stickers included; text and shapes reference none).
      if (
        clipboard.some((cb) => {
          const assetId =
            cb.kind === "transition"
              ? undefined
              : cb.kind === "overlay"
                ? isStickerOverlay(cb.item)
                  ? cb.item.assetId
                  : undefined
                : cb.item.assetId;
          return assetId !== undefined && !s.assets.some((a) => a.id === assetId);
        })
      )
        return false;
      push();
      // The paste lands under the skimmer while one is live, at the playhead
      // otherwise — the same moment the preview is showing.
      const t = Math.max(0, previewAt());
      const newSel: Selection[] = [];
      set((cur) => {
        let clips = cur.clips;
        let audioClips = cur.audioClips;
        let overlays = cur.overlays;
        let transitions = cur.transitions;
        // A copy is its own thing: pasted group members stay grouped with each
        // other and join nothing that was already on the timeline.
        const regroup = groupRemap(uid);
        // When clips ride the same paste, their transition bars follow them by
        // this shift, so a copied sequence keeps its blends on its own cuts.
        let clipDelta: number | null = null;
        // Every item aims for the paste point but respects what already sits on
        // its lane: an occupied spot slides the paste right to the next gap
        // that fits. Earlier items of this same paste count too.
        for (const cb of clipboard) {
          if (cb.kind === "transition") continue; // placed below, once clips landed
          if (cb.kind === "clip") {
            // Collision is per-track: a clip lands clear of others on its own
            // row only.
            const taken = footprints(clips.filter((c) => c.track === cb.item.track));
            const clip: VideoClip = {
              ...cb.item,
              id: uid(),
              start: nextFreeStart(taken, t, clipLen(cb.item)),
            };
            clipDelta ??= clip.start - cb.item.start;
            clips = [...clips, clip].sort((a, b) => a.start - b.start);
            newSel.push({ kind: "clip", id: clip.id });
          } else if (cb.kind === "audio") {
            const taken = footprints(
              audioClips.filter((a) => (a.lane ?? 0) === (cb.item.lane ?? 0)),
            );
            const item: AudioClip = { ...cb.item, id: uid(), start: nextFreeStart(taken, t, clipLen(cb.item)) };
            audioClips = [...audioClips, item];
            newSel.push({ kind: "audio", id: item.id });
          } else {
            const len = Math.max(0.2, cb.item.end - cb.item.start);
            const taken = overlays
              .filter((o) => (o.lane ?? 0) === (cb.item.lane ?? 0))
              .map((o) => ({ start: o.start, end: o.end }));
            const start = nextFreeStart(taken, t, len);
            const item: Overlay = {
              ...cb.item,
              id: uid(),
              start,
              end: start + len,
              ...regroup(cb.item),
            };
            overlays = [...overlays, item];
            newSel.push({ kind: "overlay", id: item.id });
          }
        }
        // Transition bars land last, against the row as this paste left it.
        // Bars copied together with clips keep their place in the copied
        // sequence; a bar-only paste lands like a drop from the panel — onto
        // the boundary nearest the paste point when one is in reach (replacing
        // whatever played there), parked exactly at the paste point otherwise. A
        // multi-bar paste keeps the bars' spacing, anchored by the earliest.
        const barItems = clipboard
          .flatMap((cb) => (cb.kind === "transition" ? [cb.item] : []))
          .sort((a, b) => a.start - b.start);
        if (barItems.length > 0) {
          let delta = clipDelta;
          if (delta === null) {
            const first = barItems[0];
            const bounds = transitionBoundaries(clips);
            const near = bounds.reduce<TransitionBoundary | null>(
              (found, b) => (!found || Math.abs(b.at - t) < Math.abs(found.at - t) ? b : found),
              null
            );
            if (near && Math.abs(near.at - t) <= BAR_PASTE_REACH) {
              delta =
                (near.kind === "in" ? near.at : near.at - first.seconds) - first.start;
              // The landed bar takes over the boundary; the bar that played
              // it leaves with it, the way a drop replaces the incumbent.
              const roles = resolveTransitions(clips, transitions);
              const incumbent = transitions.find((x) =>
                (roles.get(x.id) ?? []).some(
                  (r) => r.kind === near.kind && r.clipId === near.clipId
                )
              );
              if (incumbent) transitions = transitions.filter((x) => x.id !== incumbent.id);
            } else {
              delta = t - first.start;
            }
          }
          for (const item of barItems) {
            const bar: TimelineTransition = {
              ...item,
              id: uid(),
              start: Math.max(0, item.start + delta),
            };
            transitions = [...transitions, bar];
            newSel.push({ kind: "transition", id: bar.id });
          }
        }
        return { clips, audioClips, overlays, transitions, selection: newSel[newSel.length - 1] ?? null, multiSelection: newSel };
      });
      return true;
    },

    undo: () => {
      flush(); // commit any uncommitted edit before stepping back
      const prev = history.pop();
      if (!prev) return;
      future.push(snapshot());
      restoreDoc(prev);
    },

    redo: () => {
      flush();
      const next = future.pop();
      if (!next) return;
      history.push(snapshot());
      if (history.length > HISTORY_CAP) history.shift();
      restoreDoc(next);
    },
  };
});

// Track real edits to the persistable doc so a deferred checkpoint (see push)
// knows whether an edit actually happened between capture and commit.
useEditor.subscribe((s, prev) => {
  if (
    s.clips !== prev.clips ||
    s.transitions !== prev.transitions ||
    s.audioClips !== prev.audioClips ||
    s.overlays !== prev.overlays ||
    s.subtitles !== prev.subtitles
  )
    docSeq++;
});

// Every subtitles pass — transcription, translation, AI captions — rides
// subtitleStatus, so this one watch badges the Subtitles rail tile whenever a
// pass settles while the tab is closed (landed() no-ops while it's watched).
// A project load also drops "running", inside the same set() that clears
// `loaded` — the guard keeps that reset off the badge.
useEditor.subscribe((s, prev) => {
  if (prev.subtitleStatus === "running" && s.subtitleStatus !== "running" && s.loaded)
    useGenNotify.getState().landed("subtitles", `subs-${Date.now()}`);
});

/** An upload whose bytes exist only in this tab. One backed by the browser
 * store survives a reload, so it may reach the document like a landed file. */
const tabOnlyUpload = (a: MediaAsset) => a.upload !== undefined && !a.upload.stored;

/** Ids of the assets still uploading from tab-scoped bytes, as a comparable
 * key ("" when none). An import is on screen before its bytes are stored, and
 * nothing about it may reach the document until they are. */
function pendingKey(assets: MediaAsset[]): string {
  let key = "";
  for (const a of assets) if (tabOnlyUpload(a)) key += `${a.id},`;
  return key;
}

/** Clips are held back from the document while their asset is still uploading
 * from tab-scoped bytes: one pointing at bytes this tab never finished sending
 * would reopen broken. Memoized, so autosave's change detector can compare the
 * projection by reference and an upload in flight doesn't read as a stream of
 * edits. */
function docClipFilter<T extends { assetId: string }>() {
  let memo: { clips: T[]; key: string; out: T[] } | null = null;
  return (clips: T[], assets: MediaAsset[]): T[] => {
    const key = pendingKey(assets);
    if (memo && memo.clips === clips && memo.key === key) return memo.out;
    const out = key
      ? clips.filter((c) => !assets.some((a) => a.id === c.assetId && tabOnlyUpload(a)))
      : clips;
    memo = { clips, key, out };
    return out;
  };
}
export const docClips = docClipFilter<VideoClip>();
export const docAudioClips = docClipFilter<AudioClip>();

/** The overlay elements as the document stores them — the loader-stamped
 * `kind` dropped off text. Memoized on the live array like `docClips`, because
 * autosave tells an edit from a re-read by comparing this projection's
 * identity: rebuilding it on every read would mark the document dirty forever.
 */
export const docOverlays = (() => {
  let memo: { overlays: Overlay[]; out: Overlay[] } | null = null;
  return (overlays: Overlay[]): Overlay[] => {
    if (memo && memo.overlays === overlays) return memo.out;
    const out = stripDefaultOverlayKinds(overlays);
    memo = { overlays, out };
    return out;
  };
})();

/** The asset fields persisted in project.json — the projection autosave
 * writes, and the one its change detector compares (runtime fields like
 * thumbs/peaks must not mark the doc dirty). Assets whose bytes live only in
 * this tab are left out entirely; they join the document when they land — or
 * straight away when the browser store holds their bytes. */
export function storedAssets(assets: MediaAsset[]): StoredAsset[] {
  return assets
    .filter((a) => !tabOnlyUpload(a))
    .map(({ id, fileName, name, type, duration, width, height, origin, chatId, language, watch, speech }) => ({
      id,
      fileName,
      name,
      type,
      duration,
      ...(width !== undefined ? { width } : {}),
      ...(height !== undefined ? { height } : {}),
      ...(origin !== undefined ? { origin } : {}),
      ...(chatId !== undefined ? { chatId } : {}),
      ...(language !== undefined ? { language } : {}),
      ...(watch !== undefined ? { watch } : {}),
      ...(speech !== undefined ? { speech } : {}),
    }));
}

/** The persistable slice of the editor state, for autosave. */
export function serializeDoc(s: {
  projectName: string;
  assets: MediaAsset[];
  clips: VideoClip[];
  transitions: TimelineTransition[];
  audioClips: AudioClip[];
  overlays: Overlay[];
  templates: LibraryTemplate[];
  aspect: Aspect;
  fadeIn: number;
  fadeOut: number;
  background: string;
  publish: { caption: string; tags: string; soundTitle: string; handle: string };
  notes: { text: string; publishedAt: string; links: string[] };
  subtitles: SubtitlesBlock;
  genvideo?: VideoProject;
  renders: RenderRecord[];
  firstOpen?: ProjectDoc["firstOpen"];
}): Partial<ProjectDoc> {
  return {
    name: s.projectName,
    assets: storedAssets(s.assets),
    clips: docClips(s.clips, s.assets),
    transitions: s.transitions.map((t) => ({ ...t })),
    audioClips: docAudioClips(s.audioClips, s.assets),
    // Text elements drop the loader-stamped `kind`, so title-only projects
    // serialize byte-identical to the pre-union shape.
    overlays: docOverlays(s.overlays),
    templates: s.templates,
    aspect: s.aspect,
    fadeIn: s.fadeIn,
    fadeOut: s.fadeOut,
    background: s.background,
    subtitles: s.subtitles,
    publish: { ...s.publish },
    notes: { ...s.notes, links: [...s.notes.links] },
    // Explicit null when there is no run: absence means "keep what you have"
    // to the PUT handler, so a dismissed plan could otherwise never be cleared.
    genvideo: s.genvideo ?? null,
    renders: s.renders,
    firstOpen: s.firstOpen,
  };
}

/** Effective playback rate of a video clip (>0, default 1). */
export function clipSpeed(c: VideoClip) {
  const s = c.speed ?? 1;
  return s > 0 ? s : 1;
}

export function clipLen(c: VideoClip | AudioClip) {
  const src = c.out - c.in;
  // Video clips play their source at `speed`, so the timeline footprint is
  // shorter/longer than the source. Audio clips have no speed.
  const eff = "speed" in c && c.speed && c.speed > 0 ? src / c.speed : src;
  return Math.max(MIN_LEN, eff);
}

/** How closely two starts/ends must agree to count as the same cut. */
const TOUCH_EPS = 0.02;

/**
 * The live blend length (timeline seconds) of `a`'s transition into `b`.
 *
 * A transition is a render-time blend at the cut: during the last blend
 * seconds of `a`, the incoming clip's first frame arrives over `a`'s live
 * tail, and at the cut `b` plays from its head. Clips never intersect in
 * time — the blend claims no layout, moves nothing, and resizes nothing.
 * It is live only while the pair actually touches; clips dragged apart
 * keep the declared length and the blend comes back when they meet again.
 * Clamped so it can never swallow either clip whole.
 */
export function transitionOverlap(a: VideoClip, b: VideoClip | undefined): number {
  const d = a.transition ?? 0;
  if (!b || d <= 0) return 0;
  if (Math.abs(a.start + clipLen(a) - b.start) > TOUCH_EPS) return 0;
  return Math.min(d, clipLen(a) * 0.9, clipLen(b) * 0.9);
}

/** Clamp a bar's blend length to the range every consumer expects. */
const clampBarSeconds = (s: number) => Math.max(0.1, Math.min(TRANSITION_MAX, s));

/** The place a transition bar is playing at: the cut it ends on (`clipId` is
 * the outgoing clip), or the open head/tail it rides. */
export type TransitionRole = { kind: "cut" | "in" | "out"; clipId: string };

type TransitionBoundary = TransitionRole & { at: number };

/** Every place on every video track with a handover to make: a cut where one
 * clip touches the next, and the open edges — a head with nothing before it,
 * a tail with nothing after. */
function transitionBoundaries(clips: VideoClip[]): TransitionBoundary[] {
  const out: TransitionBoundary[] = [];
  const tracks = [...new Set(clips.map((c) => c.track))].sort((a, b) => a - b);
  for (const track of tracks) {
    const row = clips.filter((c) => c.track === track).sort((a, b) => a.start - b.start);
    row.forEach((c, i) => {
      const end = c.start + clipLen(c);
      const prev = row[i - 1];
      const next = row[i + 1];
      if (!prev || prev.start + clipLen(prev) < c.start - TOUCH_EPS)
        out.push({ kind: "in", clipId: c.id, at: c.start });
      if (next && next.start <= end + TOUCH_EPS) out.push({ kind: "cut", clipId: c.id, at: end });
      else out.push({ kind: "out", clipId: c.id, at: end });
    });
  }
  return out;
}

/** Whether a bar's style has anything to play at this kind of boundary. A
 * cut hands one clip's sound and picture to the next, so every style plays
 * one. An open head or tail has only the single clip's edge to ramp, which is
 * a picture ramp — a sound dissolve has nothing to blend there, so it never
 * claims the boundary: it reads as parked, which is what it is, and the AI's
 * debris report names it. */
const playsBoundary = (style: TransitionStyle, kind: TransitionRole["kind"]): boolean =>
  kind === "cut" || animStyleOfTransition(style) !== null;

/**
 * Match each transition bar to the boundaries it lines up with, by time
 * alone: a bar plays every cut or open tail its end sits on and every open
 * head its start sits on — several tracks cutting at the same instant share
 * the one bar, so a simultaneous multi-track handover never needs a stack of
 * identical bars. A bar aligned with nothing is inert — it stays on the row,
 * does nothing, and starts playing the moment a boundary lines up with it.
 * One bar per boundary; when two claim the same one, the newest wins. A
 * bar's list is rank-ordered, so its first role (cut before in before out)
 * is the one that names it.
 */
export function resolveTransitions(
  clips: VideoClip[],
  transitions: TimelineTransition[]
): Map<string, TransitionRole[]> {
  const bounds = transitionBoundaries(clips);
  const rank = { cut: 0, in: 1, out: 2 } as const;
  const taken = new Set<TransitionBoundary>();
  const roles = new Map<string, TransitionRole[]>();
  for (let i = transitions.length - 1; i >= 0; i--) {
    const t = transitions[i];
    const fits = bounds
      .filter(
        (b) =>
          !taken.has(b) &&
          playsBoundary(t.style, b.kind) &&
          Math.abs((b.kind === "in" ? t.start : t.start + t.seconds) - b.at) <= TOUCH_EPS
      )
      .sort((a, b) => rank[a.kind] - rank[b.kind]);
    if (fits.length === 0) continue;
    for (const b of fits) taken.add(b);
    roles.set(
      t.id,
      fits.map((b) => ({ kind: b.kind, clipId: b.clipId }))
    );
  }
  return roles;
}

/**
 * The bars lining up with nothing: on the row, playing no cut and no clip
 * edge. A user who drags a clip away sees the bar it left and can drag it
 * back; an assistant edit has no such eye, so the tool layer reports these
 * after every timeline mutation and the model clears or reattaches them.
 */
export function parkedTransitions(
  clips: VideoClip[],
  transitions: TimelineTransition[]
): TimelineTransition[] {
  if (transitions.length === 0) return [];
  const roles = resolveTransitions(clips, transitions);
  return transitions.filter((t) => !(roles.get(t.id) ?? []).length);
}

/**
 * Carry the bars through a retime: every bar keeps playing the boundary it
 * played, at wherever that boundary moved to.
 *
 * A bar is a free object — dragging a clip somewhere else leaves it where it
 * is, and it plays again when something lines up with it. A retime is the
 * other thing: closing a hole, pushing a run, growing a footprint all move
 * footage the user never aimed at, so the blends riding those cuts travel with
 * them. The retiming edits call this with the row as it stood before; bars
 * playing nothing, and bars whose clip is gone, stay put.
 */
export function reanchorTransitions(
  before: VideoClip[],
  after: VideoClip[],
  transitions: TimelineTransition[]
): TimelineTransition[] {
  if (transitions.length === 0) return transitions;
  const roles = resolveTransitions(before, transitions);
  if (roles.size === 0) return transitions;
  const byId = new Map(after.map((c) => [c.id, c]));
  let changed = false;
  const out = transitions.map((t) => {
    // The primary role decides where a multi-boundary bar travels to; the
    // other tracks' boundaries moved with the same retime.
    const role = roles.get(t.id)?.[0];
    const clip = role && byId.get(role.clipId);
    if (!clip) return t;
    const at = role.kind === "in" ? clip.start : clip.start + clipLen(clip);
    const start = role.kind === "in" ? at : at - t.seconds;
    if (Math.abs(start - t.start) <= TOUCH_EPS) return t;
    changed = true;
    return { ...t, start };
  });
  return changed ? out : transitions;
}

const sameAnim = (a: ClipAnim | undefined, b: ClipAnim | undefined) =>
  a === b || (!!a && !!b && a.style === b.style && a.seconds === b.seconds);

/**
 * A clip's `transition`/`animIn`/`animOut` fields are caches of the bars:
 * whichever bar plays a clip's cut, head, or tail writes the matching field,
 * and a clip no bar plays goes plain. Runs inside the store's set wrapper on
 * every clips/transitions write, so the fields can never disagree with the
 * bars. Same array back when nothing changes.
 */
export function deriveTransitionFields(
  clips: VideoClip[],
  transitions: TimelineTransition[]
): VideoClip[] {
  const roles = resolveTransitions(clips, transitions);
  const byBoundary = new Map<string, TimelineTransition>();
  for (const t of transitions) {
    for (const r of roles.get(t.id) ?? []) byBoundary.set(`${r.kind}:${r.clipId}`, t);
  }
  let changed = false;
  const next = clips.map((c) => {
    const cut = byBoundary.get(`cut:${c.id}`);
    const transition = cut ? clampBarSeconds(cut.seconds) : undefined;
    const transitionStyle = cut && cut.style !== "crossfade" ? cut.style : undefined;
    const animOf = (t: TimelineTransition | undefined): ClipAnim | undefined => {
      if (!t) return undefined;
      // Only a style with an edge ramp reaches an open edge — a sound
      // dissolve never takes one (`playsBoundary`).
      const style = animStyleOfTransition(t.style)!;
      return {
        // Upper tracks composite through alpha, so their edges render the
        // ramps alpha can express.
        style: c.track > 0 ? overlayAnimStyle(style) : style,
        seconds: clampBarSeconds(t.seconds),
      };
    };
    const animIn = animOf(byBoundary.get(`in:${c.id}`));
    const animOut = animOf(byBoundary.get(`out:${c.id}`));
    if (
      c.transition === transition &&
      c.transitionStyle === transitionStyle &&
      sameAnim(c.animIn, animIn) &&
      sameAnim(c.animOut, animOut)
    )
      return c;
    changed = true;
    return { ...c, transition, transitionStyle, animIn, animOut };
  });
  return changed ? next : clips;
}

/** Bring a stored bar list back to the shape the editor expects. Exact twins
 * — same footprint, same style — collapse to one: at most one bar can play a
 * boundary, so the copies stack invisibly under it and read as a bar that
 * refuses to delete. */
function sanitizeTransitions(raw: TimelineTransition[] | undefined): TimelineTransition[] {
  const bars = (raw ?? [])
    .filter((t) => t && typeof t.start === "number" && typeof t.seconds === "number")
    .map((t) => ({
      id: t.id || uid(),
      start: t.start,
      seconds: clampBarSeconds(t.seconds),
      style: TRANSITION_STYLE_IDS.includes(t.style) ? t.style : "crossfade",
    }));
  return bars.filter(
    (t, i) =>
      bars.findIndex(
        (u) =>
          u.style === t.style &&
          Math.abs(u.start - t.start) < 0.001 &&
          Math.abs(u.seconds - t.seconds) < 0.001
      ) === i
  );
}

/**
 * Docs saved when transitions and edge animations lived on clips: each stored
 * field becomes a bar at its natural window, unless a bar already plays that
 * boundary. Runs at load only — live edits write bars directly, and the
 * derived fields always have a bar behind them.
 */
export function adoptTransitionFields(
  clips: VideoClip[],
  transitions: TimelineTransition[]
): TimelineTransition[] {
  const roles = resolveTransitions(clips, transitions);
  const claimed = new Set([...roles.values()].flat().map((r) => `${r.kind}:${r.clipId}`));
  const out = [...transitions];
  const add = (key: string, bar: Omit<TimelineTransition, "id">) => {
    claimed.add(key);
    out.push({ id: uid(), ...bar });
  };
  // The clip each head touches, when one does. A joint carries exactly one
  // blend, so an entrance stored on a clip arriving at one becomes that blend
  // rather than a bar with nothing to play.
  const joints = new Map<string, VideoClip>();
  for (const track of new Set(clips.map((c) => c.track))) {
    const row = clips.filter((c) => c.track === track).sort((a, b) => a.start - b.start);
    row.forEach((c, i) => {
      const prev = row[i - 1];
      if (prev && prev.start + clipLen(prev) >= c.start - TOUCH_EPS) joints.set(c.id, prev);
    });
  }
  // Tails first, so a clip's own blend takes its joint before the clip
  // arriving there offers an entrance for it.
  for (const c of clips) {
    const end = c.start + clipLen(c);
    const d = Math.min(c.transition ?? 0, TRANSITION_MAX);
    const tailFree = !claimed.has(`cut:${c.id}`) && !claimed.has(`out:${c.id}`);
    if (d > 0 && tailFree) {
      add(`cut:${c.id}`, {
        start: end - d,
        seconds: clampBarSeconds(d),
        style: TRANSITION_STYLE_IDS.includes(c.transitionStyle as TransitionStyle)
          ? (c.transitionStyle as TransitionStyle)
          : "crossfade",
      });
    } else if (c.animOut && tailFree) {
      const seconds = clampBarSeconds(c.animOut.seconds);
      add(`cut:${c.id}`, {
        start: end - seconds,
        seconds,
        style: transitionStyleOfAnim(c.animOut.style),
      });
    }
  }
  for (const c of clips) {
    if (!c.animIn) continue;
    const seconds = clampBarSeconds(c.animIn.seconds);
    const style = transitionStyleOfAnim(c.animIn.style);
    const joint = joints.get(c.id);
    if (!joint) {
      if (!claimed.has(`in:${c.id}`)) add(`in:${c.id}`, { start: c.start, seconds, style });
    } else if (!claimed.has(`cut:${joint.id}`) && !claimed.has(`out:${joint.id}`)) {
      // The entrance played against the clip before it; at a joint that is the
      // blend at the cut, and it keeps the length and look it was saved with.
      add(`cut:${joint.id}`, { start: c.start - seconds, seconds, style });
    }
  }
  return out.length === transitions.length ? transitions : out;
}

/**
 * The invariant every video track keeps: clips never overlap in time.
 *
 * Docs saved when a transition was a physical overlap stored the incoming
 * clip inside the outgoing one's footprint. On load, each intruding clip —
 * and everything after it on its track, gaps preserved — moves right until
 * the pair abuts, so the transition still sits on a cut and nothing plays
 * differently twice.
 *
 * Pulling the picture apart makes the cut longer, so everything timed against
 * it comes along: track 0 is the spine, and each title, caption and soundtrack
 * clip moves by whatever the footage under it moved. The same document back
 * when nothing intrudes.
 */
export function separateOverlaps<
  T extends {
    clips: VideoClip[];
    audioClips: AudioClip[];
    overlays: Overlay[];
    cues: SubtitleCue[];
  },
>(doc: T): T {
  const tracks = new Set(doc.clips.map((c) => c.track));
  let out = doc.clips;
  // Where the spine moved, as (old time, shift) steps in play order.
  let spine: { at: number; shift: number }[] = [];
  for (const track of tracks) {
    const row = out
      .filter((c) => c.track === track)
      .sort((a, b) => a.start - b.start);
    let shift = 0;
    const moved = new Map<string, number>();
    const steps: { at: number; shift: number }[] = [];
    for (let i = 0; i < row.length; i++) {
      const start = row[i].start + shift;
      if (i > 0) {
        const prevEnd = moved.get(row[i - 1].id)! + clipLen(row[i - 1]);
        if (start < prevEnd - 1e-3) shift += prevEnd - start;
      }
      moved.set(row[i].id, row[i].start + shift);
      steps.push({ at: row[i].start, shift });
    }
    if (shift > 0) {
      out = out.map((c) =>
        c.track === track && moved.get(c.id) !== c.start
          ? { ...c, start: moved.get(c.id)! }
          : c
      );
      if (track === 0) spine = steps;
    }
  }
  if (out === doc.clips) return doc;
  if (spine.length === 0) return { ...doc, clips: out };
  const at = (t: number) => {
    let shift = 0;
    for (const step of spine) {
      if (step.at > t + 1e-3) break;
      shift = step.shift;
    }
    return t + shift;
  };
  return {
    ...doc,
    clips: out,
    audioClips: doc.audioClips.map((a) => ({ ...a, start: at(a.start) })),
    overlays: doc.overlays.map((o) => ({ ...o, start: at(o.start), end: at(o.end) })),
    cues: doc.cues.map((c) => ({
      ...c,
      start: at(c.start),
      end: at(c.end),
      words: c.words?.map((w) => ({ ...w, t0: at(w.t0), t1: at(w.t1) })),
    })),
  };
}

/**
 * Spans for one track, cached until the document moves.
 *
 * Every frame of playback and every pixel of a scrub asks for these, and some
 * of the askers are React selectors that run on every store write. Rebuilding
 * the list each time meant an asset `Map`, a filter/map/sort and a `ClipSpan`
 * per clip — several times a frame, discarded. Clips and assets are replaced
 * wholesale on an edit, so identity is a sound cache key: same arrays, same
 * answer.
 *
 * Callers treat the result as read-only. Nothing sorts or pushes into it, and
 * anything that wants to would be handing the next caller a different timeline.
 */
let spansClips: VideoClip[] | null = null;
let spansAssets: MediaAsset[] | null = null;
const spansByTrack = new Map<number, ClipSpan[]>();

export function getClipSpans(clips: VideoClip[], assets: MediaAsset[], track = 0): ClipSpan[] {
  if (clips !== spansClips || assets !== spansAssets) {
    spansClips = clips;
    spansAssets = assets;
    spansByTrack.clear();
  }
  const hit = spansByTrack.get(track);
  if (hit) return hit;
  const built = buildClipSpans(clips, assets, track);
  spansByTrack.set(track, built);
  return built;
}

function buildClipSpans(clips: VideoClip[], assets: MediaAsset[], track: number): ClipSpan[] {
  // One track's clips in sequence, each with its live dissolve overlap into
  // the next. Track 0 is the spine that drives playback; upper tracks carry
  // their own transitions between their own clips.
  // Map lookup, not a per-clip assets.find — this runs every playback frame.
  const byId = new Map(assets.map((a) => [a.id, a]));
  const present = clips
    .filter((clip) => clip.track === track)
    .map((clip) => ({ clip, asset: byId.get(clip.assetId) }))
    .filter((x): x is { clip: VideoClip; asset: MediaAsset } => !!x.asset)
    .sort((a, b) => a.clip.start - b.clip.start);
  const spans: ClipSpan[] = [];
  for (let i = 0; i < present.length; i++) {
    const { clip, asset } = present[i];
    const len = clipLen(clip);
    const next = present[i + 1]?.clip;
    // The blend into the next clip, live only at a cut the pair actually
    // makes; clips dragged apart dissolve into nothing. A sound style hands
    // over on the audio alone, so its window lands on the other field and
    // every reader of the picture blend sees a plain cut.
    const overlap = transitionOverlap(clip, next);
    const onSound = isAudioTransition(clip.transitionStyle);
    spans.push({
      clip,
      asset,
      start: clip.start,
      len,
      transitionOut: onSound ? 0 : overlap,
      soundOut: onSound ? overlap : 0,
    });
  }
  return spans;
}

/** One row of the timeline, whichever kind of thing sits on it. Video rows are
 * `track`; audio and title rows are the item's `lane`. */
export type LaneRef =
  | { kind: "video"; index: number }
  | { kind: "audio"; index: number }
  | { kind: "overlay"; index: number };

export const sameLane = (a: LaneRef, b: LaneRef) => a.kind === b.kind && a.index === b.index;

/** Every footprint on one row, in play order. */
function laneSpans(
  doc: { clips: VideoClip[]; audioClips: AudioClip[]; overlays: Overlay[] },
  lane: LaneRef
): { start: number; end: number }[] {
  const spans =
    lane.kind === "video"
      ? doc.clips
          .filter((c) => c.track === lane.index)
          .map((c) => ({ start: c.start, end: c.start + clipLen(c) }))
      : lane.kind === "audio"
        ? doc.audioClips
            .filter((a) => (a.lane ?? 0) === lane.index)
            .map((a) => ({ start: a.start, end: a.start + clipLen(a) }))
        : doc.overlays
            .filter((o) => (o.lane ?? 0) === lane.index)
            .map((o) => ({ start: o.start, end: o.end }));
  return spans.sort((a, b) => a.start - b.start);
}

/** The empty span on `lane` containing time `t` — the stretch between two
 * footprints (or before the first one). Null when `t` sits on an item or past
 * the last one (there is nothing after trailing space to pull left). */
export function laneGapAt(
  doc: { clips: VideoClip[]; audioClips: AudioClip[]; overlays: Overlay[] },
  lane: LaneRef,
  t: number
): { start: number; len: number } | null {
  let prevEnd = 0;
  for (const s of laneSpans(doc, lane)) {
    if (s.start - prevEnd > 0.05 && t >= prevEnd && t < s.start) {
      return { start: prevEnd, len: s.start - prevEnd };
    }
    prevEnd = Math.max(prevEnd, s.end);
  }
  return null;
}

/** Cut the timeline range [at, at + delta) out of the whole document — the
 * ripple half of a track-0 delete. Items past the hole slide left by delta;
 * items wholly inside it are removed; items straddling an edge keep the part
 * that survives (a layer/soundtrack clip spanning the hole splits around it,
 * excising those source seconds). Track-0 clips only shift: the hole is a
 * deleted track-0 clip's own footprint, so no survivor there can straddle it. */
function exciseRange(
  doc: {
    clips: VideoClip[];
    audioClips: AudioClip[];
    overlays: Overlay[];
    cues: SubtitleCue[];
  },
  at: number,
  delta: number
): typeof doc {
  const EPS = 0.001;
  const end = at + delta;

  const cutClip = <T extends VideoClip | AudioClip>(c: T): T[] => {
    const speed = c.speed && c.speed > 0 ? c.speed : 1;
    const stop = c.start + clipLen(c);
    if (stop <= at + EPS) return [c];
    if (c.start >= end - EPS) return [{ ...c, start: c.start - delta }];
    const pieces: T[] = [];
    if (c.start < at) pieces.push({ ...c, out: c.in + (at - c.start) * speed });
    if (stop > end) pieces.push({ ...c, id: pieces.length ? uid() : c.id, start: at, in: c.in + (end - c.start) * speed });
    return pieces.filter((p) => (p.out - p.in) / speed >= MIN_LEN);
  };

  const cutText = (o: Overlay): Overlay[] => {
    if (o.end <= at + EPS) return [o];
    if (o.start >= end - EPS) return [{ ...o, start: o.start - delta, end: o.end - delta }];
    const start = Math.min(o.start, at);
    const stop = o.end > end ? o.end - delta : at;
    return stop - start >= MIN_LEN ? [{ ...o, start, end: stop }] : [];
  };

  const cutCue = (c: SubtitleCue): SubtitleCue[] => {
    if (c.end <= at + EPS) return [c];
    if (c.start >= end - EPS) {
      return [{
        ...c,
        start: c.start - delta,
        end: c.end - delta,
        words: c.words?.map((w) => ({ ...w, t0: w.t0 - delta, t1: w.t1 - delta })),
      }];
    }
    const start = Math.min(c.start, at);
    const stop = c.end > end ? c.end - delta : at;
    if (stop - start < MIN_LEN) return [];
    // Same convention as splitCue: a word sits left of a cut when it starts
    // before it. Words swallowed by the hole go with it; later ones slide left
    // and the text follows the surviving words.
    const words = c.words
      ?.filter((w) => w.t0 < at || w.t0 >= end)
      .map((w) => (w.t0 >= end ? { ...w, t0: w.t0 - delta, t1: w.t1 - delta } : w));
    return [{
      ...c,
      start,
      end: stop,
      words: words?.length ? words : undefined,
      text: words?.length ? words.map((w) => w.w).join(" ") : c.text,
    }];
  };

  return {
    clips: doc.clips.flatMap((c) =>
      c.track !== 0 ? cutClip(c) : c.start >= end - EPS ? [{ ...c, start: c.start - delta }] : [c]
    ),
    audioClips: doc.audioClips.flatMap(cutClip),
    overlays: doc.overlays.flatMap(cutText),
    cues: doc.cues.flatMap(cutCue),
  };
}

/** One video clip's timeline window with its asset, wherever the clip lives:
 * track-0 clips read theirs off the span fold, layer clips straight from their
 * own placement. Null when the clip or its asset is gone. */
export function clipWindow(
  clips: VideoClip[],
  assets: MediaAsset[],
  clipId: string
): { clip: VideoClip; asset: MediaAsset; start: number; len: number } | null {
  const clip = clips.find((c) => c.id === clipId);
  if (!clip) return null;
  if (clip.track === 0) {
    const sp = getClipSpans(clips, assets).find((x) => x.clip.id === clipId);
    return sp ? { clip: sp.clip, asset: sp.asset, start: sp.start, len: sp.len } : null;
  }
  const asset = assets.find((a) => a.id === clip.assetId);
  return asset ? { clip, asset, start: clip.start, len: clipLen(clip) } : null;
}

/** End of video track 0: where its last clip runs out (clips are free-placed,
 * so gaps count toward this, they just play black). */
export function totalDuration(clips: VideoClip[]) {
  let end = 0;
  for (const c of clips) if (c.track === 0) end = Math.max(end, c.start + clipLen(c));
  return end;
}

/** A track-0 clip as older docs stored it: packed by array order, no `start`. */
type LegacyClip = Omit<VideoClip, "start"> & { start?: number };

/** Assign packed sequential starts (each clip abutting the previous): the
 * layout older docs implied by array order. */
function packStarts(clips: LegacyClip[]): VideoClip[] {
  let t = 0;
  const out: VideoClip[] = [];
  for (const c of clips) {
    const clip = { ...c, start: t } as VideoClip;
    t += clipLen(clip);
    out.push(clip);
  }
  return out;
}

/** Video track 0 as a gapless sequence for the sequential render graphs
 * (export, transcription): each span in start order, with the length of the
 * black/silent spacer that precedes it wherever the free-placed clips leave
 * the track empty. Sub-50ms gaps are treated as abutting. */
export function spanSequence(spans: ClipSpan[]): { gapBefore: number; span: ClipSpan }[] {
  const out: { gapBefore: number; span: ClipSpan }[] = [];
  let cursor = 0;
  for (const sp of spans) {
    const gap = sp.start - cursor;
    out.push({ gapBefore: gap > 0.05 ? gap : 0, span: sp });
    cursor = sp.start + sp.len;
  }
  return out;
}

/**
 * Display order of the overlay rows, top row first.
 *
 * The lane number is the order: row 0 is the top row, and used lanes compact
 * to contiguous rows so an emptied one disappears. Nothing about a kind moves
 * a row, which is what lets a drag put any element on any row and have it
 * stay — new effects open a row at the top (`elementPlacement`), and from
 * there the user decides.
 *
 * Rendering and lane drags both order rows through here. If they disagreed, a
 * row index would mean one thing on screen and another to the drop, and an
 * item would land a row away from where it was aimed.
 */
export function overlayLaneOrder(overlays: Overlay[]): number[] {
  return [...new Set(overlays.map((o) => o.lane ?? 0))].sort((a, b) => a - b);
}

/**
 * Move effects off rows they share with titles, shapes or stickers, onto an
 * effect row where their stretch of the timeline is free.
 *
 * Docs written before effects claimed their own rows put every element on
 * lane 0. `normalizeElementLanes` runs this on load, then numbers the rows.
 */
function splitEffectLanes(overlays: Overlay[]): Overlay[] {
  const laneOf = (o: Overlay) => o.lane ?? 0;
  const shared = new Set(
    overlays
      .map(laneOf)
      .filter((l) =>
        overlays.some((o) => laneOf(o) === l && isEffectOverlay(o)) &&
        overlays.some((o) => laneOf(o) === l && !isEffectOverlay(o))
      )
  );
  if (shared.size === 0) return overlays;
  // Placed items decide where the next one fits, so each moved effect sees
  // the ones already moved.
  const placed = overlays.filter((o) => !(isEffectOverlay(o) && shared.has(laneOf(o))));
  return overlays.map((o) => {
    if (!isEffectOverlay(o) || !shared.has(laneOf(o))) return o;
    const lanes = [...new Set(placed.map(laneOf))].sort((a, b) => a - b);
    const free = lanes.find((l) =>
      placed.every(
        (p) => laneOf(p) !== l || (isEffectOverlay(p) && (p.end <= o.start || p.start >= o.end))
      )
    );
    const moved = { ...o, lane: free ?? (lanes.length ? Math.max(...lanes) + 1 : 0) };
    placed.push(moved);
    return moved;
  });
}

/**
 * Repair the element rows of a doc written before effects had rows of their
 * own: every element sat on lane 0 there. The effects lift onto rows of their
 * own, and the rows renumber so those come first — the stack a new project
 * builds.
 *
 * A doc with no shared row comes back untouched, whatever order its rows are
 * in. That order is the user's: they can drag any element to any row, and a
 * load that re-sorted by kind would take it back on the next open.
 */
/**
 * Turn a clip's saved look into an effect element over that clip.
 *
 * A look used to be a property of one clip. It is an effect now — a stretch of
 * the timeline you can trim, move, or run across several clips — so a doc
 * written before that opens with its grades as elements, covering exactly the
 * clips they graded.
 *
 * An element grades the whole frame for its stretch, which is the spine's
 * grade and nothing else, so only track 0 lifts. A layer clip keeps the look
 * on the clip, where it still renders over that layer alone.
 */
export function liftClipLooks(
  clips: VideoClip[],
  overlays: Overlay[],
  spans: { clip: VideoClip; start: number; len: number }[]
): { clips: VideoClip[]; overlays: Overlay[] } | null {
  const graded = clips.filter((c) => c.look);
  if (graded.length === 0) return null;
  const lifted: Overlay[] = [];
  const done = new Set<string>();
  for (const c of graded) {
    const sp = spans.find((x) => x.clip.id === c.id);
    if (!sp) continue;
    done.add(c.id);
    // One row per overlapping grade, so two clips graded back to back share a
    // row and a layered pair does not.
    let lane = 0;
    while (lifted.some((o) => (o.lane ?? 0) === lane && o.start < sp.start + sp.len && o.end > sp.start))
      lane += 1;
    lifted.push({
      id: uid(),
      kind: "effect",
      effect: c.look as EffectId,
      // A look with no stored strength is full strength; an effect with none
      // is half, so the lift has to say what the grade was set to.
      amount: c.lookAmount ?? 1,
      start: sp.start,
      end: sp.start + sp.len,
      x: 0.5,
      y: 0.5,
      lane,
    });
  }
  if (lifted.length === 0) return null;
  // The grades take the top rows, the same place a new effect opens on; the
  // elements that were already there keep their order below them.
  const rows = Math.max(...lifted.map((o) => o.lane ?? 0)) + 1;
  return {
    clips: clips.map((c) =>
      done.has(c.id) ? { ...c, look: undefined, lookAmount: undefined } : c
    ),
    overlays: [...overlays.map((o) => ({ ...o, lane: (o.lane ?? 0) + rows })), ...lifted],
  };
}

export function normalizeElementLanes(overlays: Overlay[]): Overlay[] {
  const split = splitEffectLanes(overlays);
  if (split === overlays) return overlays;
  const laneOf = (o: Overlay) => o.lane ?? 0;
  const effectRow = (l: number) => split.every((o) => laneOf(o) !== l || isEffectOverlay(o));
  const order = [...new Set(split.map(laneOf))].sort(
    (a, b) => Number(effectRow(b)) - Number(effectRow(a)) || a - b
  );
  const row = new Map(order.map((l, i) => [l, i]));
  return split.map((o) => ({ ...o, lane: row.get(laneOf(o))! }));
}

/**
 * Where a new element's row is: the lowest row already holding its side —
 * effects with effects, everything else with everything else.
 *
 * With no such row yet, a title, shape or sticker takes a fresh row at the
 * bottom, while an effect opens one at the top and the rest shift down a row,
 * since an effect filters what plays under it. A drag can move it afterwards;
 * this only decides where it starts.
 */
export function elementPlacement(
  overlays: Overlay[],
  kind: OverlayKind
): { lane: number; shiftDown: boolean } {
  const laneOf = (o: Overlay) => o.lane ?? 0;
  const effect = kind === "effect";
  const lanes = [...new Set(overlays.map(laneOf))].sort((a, b) => a - b);
  const home = lanes.find((l) =>
    overlays.every((o) => laneOf(o) !== l || isEffectOverlay(o) === effect)
  );
  if (home !== undefined) return { lane: home, shiftDown: false };
  if (effect) return { lane: 0, shiftDown: lanes.length > 0 };
  return { lane: lanes.length ? Math.max(...lanes) + 1 : 0, shiftDown: false };
}

/** The playable length of the whole project: video track 0 plus anything that
 * runs past it on another video track, the soundtrack, or an element row.
 * Drives the timeline extent, the seek clamp, and export length so content
 * past track 0's end is reachable. */
let durClips: VideoClip[] | null = null;
let durAudio: AudioClip[] | null = null;
let durOverlays: Overlay[] | null = null;
let durValue = 0;

export function projectDuration(s: {
  clips: VideoClip[];
  audioClips: AudioClip[];
  overlays: Overlay[];
}): number {
  // Cached on the same identity rule as the spans above: every seek clamps
  // against this, so a drag used to walk all three lists per pointer move.
  if (s.clips === durClips && s.audioClips === durAudio && s.overlays === durOverlays) {
    return durValue;
  }
  durClips = s.clips;
  durAudio = s.audioClips;
  durOverlays = s.overlays;
  let end = 0;
  // Anything on any row extends the timeline: a layer or soundtrack running
  // past track 0's end is still reachable, and so is a title or sticker left
  // standing after the last clip — it plays over black.
  for (const c of s.clips) end = Math.max(end, c.start + clipLen(c));
  for (const a of s.audioClips) end = Math.max(end, a.start + clipLen(a));
  for (const o of s.overlays) end = Math.max(end, o.end);
  durValue = Math.max(0, end);
  return durValue;
}

/** Spread a cue's words across [start, end], each word's slice proportional to
 * its length. Used when re-timing captions to a generated voiceover, which
 * carries no per-word timestamps of its own. */
function spreadWordsEvenly(
  text: string,
  start: number,
  end: number,
): { t0: number; t1: number; w: string }[] | undefined {
  const parts = text.split(/\s+/).filter(Boolean);
  if (parts.length === 0) return undefined;
  const lengths = parts.map((w) => Math.max(1, w.length));
  const total = lengths.reduce((a, b) => a + b, 0);
  const span = Math.max(0, end - start);
  let acc = 0;
  return parts.map((w, i) => {
    const t0 = start + (acc / total) * span;
    acc += lengths[i];
    const t1 = start + (acc / total) * span;
    return { t0, t1, w };
  });
}

export const useTotalDuration = () => useEditor((s) => totalDuration(s.clips));
