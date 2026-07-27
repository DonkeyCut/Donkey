"use client";

import { apiFetch, apiJson, getBackend } from "./backend";
import { refFromAsset, refFromStockVideo, type AssetRef } from "./assetRef";
import { chatOwner, tagChatAsset } from "./chatAssets";
import { applyOwnership, useGenerate, type VideoAttempt, type VideoGenOptions } from "./generate";
import { useGenScene } from "./genScene";
import { anchorRefused } from "./genvideo/shotAttempts";
import {
  addTemplateToProject,
  createLibraryFolder,
  deleteFromLibrary,
  deleteLibraryFolder,
  deleteTemplate,
  fetchLibrary,
  importLibraryAsset,
  moveLibraryItem,
  renameLibraryFolder,
  saveAssetToLibrary,
} from "./library";
import {
  captureFreezeFrame,
  detectSilenceClientSide,
  enrichAsset,
  ensurePeaks,
  importImage,
  importStockVideo,
  importUrlMedia,
  makeContactSheetsClientSide,
  makeStillSheetClientSide,
  renderAudioSpanWav,
} from "./media";
import { requestSidePanel, SIDE_PANEL_TABS, type SidePanelTab } from "./panelRequest";
import { blobToInlineAudio, refToInlineAudio, type InlineImage } from "./refMedia";
import { characterPrompt, stockTitle } from "./stock";
import { STOCK_IMAGES } from "./stockManifest";
import { STOCK_VIDEOS } from "./stockVideoManifest";
import { applyOverlayPatchSettled, track0Clips, trackGapAt, getClipSpans, nextFreeStart, overlayLayers, TIMELINE_H_MAX, TIMELINE_H_MIN, totalDuration, useEditor } from "./store";
import { buildAiContext } from "./aiContext";
import { autoGradeFromImageData, normalizeGrade } from "./colorGrade";
import { sampleClipFrameData } from "./previewCanvas";
import { laneCues, subtitleLaneCount } from "./subtitles";
import { synthesizeMusic } from "./audioGen";
import { composeMusicPrompt } from "./composeGen";
import { stockAssetInDoc } from "./genvideo/docWriter";
import { resolveVoice, synthesizeSpeech, SPEECH_VOICES } from "./tts";
import { defaultVideoAspects } from "./videoModels";
import { DUCK_DEFAULT, generateSubtitlesReadout } from "./voiceover";
import {
  ANIM_DEFAULT_SECONDS,
  ANIM_STYLE_IDS,
  frameOf,
  IMAGE_CLIP_SECONDS,
  LAYOUTS,
  LOOK_IDS,
  MAX_SUBTITLE_LANES,
  mediaUrl,
  nearestAspect,
  normalizeAspect,
  overlayAnimStyle,
  rectOf,
  regionLabel,
  SPEED_FLOOR,
  TRANSITION_STYLE_IDS,
  type AnimStyle,
  type AudioClip,
  type ColorGrade,
  type FontId,
  type MediaAsset,
  type Selection,
  type TransitionStyle,
  type VideoClip,
} from "./types";

const round2 = (n: number) => Math.round(n * 100) / 100;

/** The model crosses the transition and animation vocabularies — the retired
 * edge styles (fadein/zoomin/…) especially. Style ids arrive as structured
 * tool input, so resolve each known synonym to the nearest supported style. */
const TRANSITION_STYLE_SYNONYMS: Record<string, TransitionStyle> = {
  fade: "crossfade",
  fadein: "crossfade",
  fadeout: "crossfade",
  dissolve: "crossfade",
  zoom: "crosszoom",
  zoomin: "crosszoom",
  zoomout: "crosszoom",
  slideleft: "pushleft",
  slideright: "pushright",
  slideup: "pushup",
  slidedown: "pushdown",
};

const ANIM_STYLE_SYNONYMS: Record<string, AnimStyle> = {
  crossfade: "fade",
  fadein: "fade",
  fadeout: "fade",
  dipblack: "fade",
  dipwhite: "fade",
  blur: "fade",
  crosszoom: "zoom",
  zoomin: "zoom",
  zoomout: "zoom",
  pushleft: "slideleft",
  pushright: "slideright",
  pushup: "slideup",
  pushdown: "slidedown",
  wipeleft: "slideleft",
  wiperight: "slideright",
  wipeup: "slideup",
  wipedown: "slidedown",
};

const GRADE_KEYS = ["brightness", "contrast", "saturation", "exposure", "temperature", "hue"] as const;

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

class ToolError extends Error {}

/**
 * Execute an assistant tool call against the live editor store.
 * Returns a small JSON-safe result; throws ToolError with a readable message.
 */
export async function runAiTool(
  name: string,
  input: Record<string, unknown>
): Promise<unknown> {
  const s = useEditor.getState();

  switch (name) {
    case "get_state":
      // The tool result carries the whole transcript; the per-message context
      // snapshot trims it, so this is how the model pulls every cue when needed.
      return buildAiContext({ fullCues: true });

    case "capture_frame": {
      const canvas = document.querySelector<HTMLCanvasElement>(".stage canvas");
      if (!canvas) throw new ToolError("No preview canvas on screen.");
      const scaled = document.createElement("canvas");
      // Downscale at the frame's own aspect (long side 640).
      const k = 640 / Math.max(canvas.width, canvas.height);
      scaled.width = Math.round(canvas.width * k);
      scaled.height = Math.round(canvas.height * k);
      const ctx = scaled.getContext("2d")!;
      ctx.drawImage(canvas, 0, 0, scaled.width, scaled.height);
      // Overlays/captions are DOM, not canvas — note that for the model.
      return { image: scaled.toDataURL("image/jpeg", 0.75), note: "Video frame only; titles and captions overlay this in the UI." };
    }

    case "watch_video": {
      const { projectId, asset, clip, speed, from, to } = resolveWatchRange(s, input);
      if (asset.type === "audio")
        throw new ToolError(`"${asset.name}" is audio — listen_audio hears it, detect_silence finds its dead air.`);
      interface WatchBody {
        sheets: { image: string; frames: { t: number; scene?: number }[] }[];
        layout: { grid: number; margin: number; padding: number };
        sceneChanges: number[];
        coveredTo: number;
        truncated: boolean;
        error?: string;
      }
      // A still is one sheet with no time axis.
      if (asset.type === "image") {
        let body: WatchBody;
        if (getBackend().kind === "cloud") {
          body = await makeStillSheetClientSide(asset.url).catch((e) => {
            throw new ToolError(e instanceof Error ? e.message : "Could not read the image.");
          });
        } else {
          const res = await apiFetch(`/api/cut/projects/${projectId}/watch`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ file: asset.fileName, still: true }),
          });
          body = await apiJson<WatchBody>(res);
          if (!res.ok) throw new ToolError(body.error ?? "Could not read the image.");
        }
        return {
          images: body.sheets.map((sh) => sh.image),
          source: { assetId: asset.id, name: asset.name },
          note: "A still image — one frame, no time axis.",
        };
      }
      let body: WatchBody;
      if (getBackend().kind === "cloud") {
        // Same defaults, clamps, and caps as the engine's watch handler.
        body = await makeContactSheetsClientSide(asset.url, {
          from,
          ...(to !== undefined ? { to } : {}),
          ...(isNum(input.interval_seconds) ? { interval: input.interval_seconds } : {}),
        }).catch((e) => {
          throw new ToolError(e instanceof Error ? e.message : "Could not watch the video.");
        });
      } else {
        const res = await apiFetch(`/api/cut/projects/${projectId}/watch`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            file: asset.fileName,
            from,
            ...(to !== undefined ? { to } : {}),
            ...(isNum(input.interval_seconds) ? { interval: input.interval_seconds } : {}),
          }),
        });
        body = await apiJson<WatchBody>(res);
        if (!res.ok) throw new ToolError(body.error ?? "Could not watch the video.");
      }
      // The engine's ffmpeg has no text renderer; the cells get their source-
      // time stamps here on a canvas. A sheet that fails to stamp rides plain —
      // sheetFrames stays the authority either way.
      let stamped = true;
      const images = await Promise.all(
        body.sheets.map((sh) =>
          stampSheet(sh.image, sh.frames.map((f) => f.t), body.layout).catch(() => {
            stamped = false;
            return sh.image;
          })
        )
      );
      return {
        images,
        sheetFrames: body.sheets.map((sh) => sh.frames.map((f) => round2(f.t))),
        sceneChanges: body.sceneChanges.map(round2),
        coveredTo: round2(body.coveredTo),
        truncated: body.truncated,
        source: { assetId: asset.id, name: asset.name, duration: round2(asset.duration) },
        ...(clip
          ? {
              clip: {
                id: clip.id,
                timelineStart: round2(clip.start),
                in: round2(clip.in),
                out: round2(clip.out),
                speed: round2(speed),
                note: `timeline_t = ${round2(clip.start)} + (source_t - ${round2(clip.in)}) / ${round2(speed)}, for source_t in [${round2(clip.in)}, ${round2(clip.out)}]`,
              },
            }
          : {}),
        note:
          "Cells read left→right then top→bottom; each stamp is SOURCE seconds." +
          (body.truncated
            ? ` Coverage stopped at ${round2(body.coveredTo)}s — call again with from=${round2(body.coveredTo)} to continue.`
            : "") +
          (stamped ? "" : " (Stamps unavailable — sheetFrames lists each cell's time.)"),
      };
    }

    case "detect_silence": {
      const { projectId, asset, clip, speed, from, to } = resolveWatchRange(s, input);
      if (asset.type === "image") throw new ToolError(`"${asset.name}" is an image — it has no audio.`);
      interface SilenceBody {
        silences: { start: number; end: number; duration: number }[];
        error?: string;
      }
      let body: SilenceBody;
      if (getBackend().kind === "cloud") {
        // Same defaults and clamps as the engine's silence handler.
        body = {
          silences: await detectSilenceClientSide(asset.url, {
            from,
            ...(to !== undefined ? { to } : {}),
            thresholdDb: clamp(isNum(input.threshold_db) ? input.threshold_db : -30, -90, 0),
            minSilence: clamp(isNum(input.min_silence) ? input.min_silence : 0.35, 0.05, 10),
          }).catch((e) => {
            throw new ToolError(
              e instanceof Error ? e.message : "Could not scan for silence."
            );
          }),
        };
      } else {
        const res = await apiFetch(`/api/cut/projects/${projectId}/silence`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            file: asset.fileName,
            from,
            ...(to !== undefined ? { to } : {}),
            ...(isNum(input.threshold_db) ? { threshold_db: input.threshold_db } : {}),
            ...(isNum(input.min_silence) ? { min_silence: input.min_silence } : {}),
          }),
        });
        body = await apiJson<SilenceBody>(res);
        if (!res.ok) throw new ToolError(body.error ?? "Could not scan for silence.");
      }
      // Pre-map each silence's overlap with the clip's trimmed range onto the
      // timeline so the model cuts on ready numbers.
      const toTimeline = (t: number) =>
        round2(clip!.start + (clamp(t, clip!.in, clip!.out) - clip!.in) / speed);
      return {
        silences: body.silences.map((x) => ({
          start: round2(x.start),
          end: round2(x.end),
          duration: round2(x.duration),
          ...(clip && x.end > clip.in && x.start < clip.out
            ? { timeline: { start: toTimeline(x.start), end: toTimeline(x.end) } }
            : {}),
        })),
        source: { assetId: asset.id, name: asset.name, duration: round2(asset.duration) },
        ...(clip
          ? {
              clip: {
                id: clip.id,
                timelineStart: round2(clip.start),
                in: round2(clip.in),
                out: round2(clip.out),
                speed: round2(speed),
              },
            }
          : {}),
        ...(body.silences.length === 0
          ? { note: "No silence at these settings — a higher threshold_db or shorter min_silence hears more." }
          : {}),
      };
    }

    case "listen_audio": {
      const { projectId, asset, clip, from, to } = resolveWatchRange(s, input);
      if (asset.type === "image")
        throw new ToolError(`"${asset.name}" is an image — it has no sound. watch_video shows it.`);
      // A whole audio asset rides its own file bytes. A video, or any trimmed
      // range, gets its audio track pulled off by the engine first — so the
      // muxed video never travels and a long source still fits the inline cap.
      const wholeAudio = asset.type === "audio" && !clip && !isNum(input.from) && !isNum(input.to);
      const inline = wholeAudio
        ? await refToInlineAudio(refFromAsset(asset))
        : await listenToSource(projectId, asset, from, to);
      if (!inline)
        throw new ToolError(
          "That stretch is too long to listen to inline (≈12MB cap) — pass a narrower from/to."
        );
      // The `audio` data URL leaves the JSON in geminiChat and rides to the
      // model as an input_audio part, the way attachments do.
      return {
        name: asset.name,
        duration: round2(asset.duration),
        ...(clip ? { clipId: clip.id } : {}),
        ...(from > 0 ? { from: round2(from) } : {}),
        ...(to !== undefined ? { to: round2(to) } : {}),
        audio: `data:${inline.mimeType};base64,${inline.data}`,
      };
    }

    case "seek": {
      if (!isNum(input.t)) throw new ToolError("t (seconds) is required.");
      s.seek(input.t);
      return { playhead: useEditor.getState().currentTime };
    }

    case "set_playing":
      s.setPlaying(Boolean(input.playing));
      return { playing: Boolean(input.playing) };

    case "select": {
      const kind = String(input.kind);
      if (kind === "none") {
        s.select(null);
        return { selection: null };
      }
      const id = String(input.id ?? "");
      // A video clip on any track selects as "clip"; "overlayClip" is accepted
      // as a legacy alias for a layer clip and resolves the same way.
      const pool =
        kind === "clip" || kind === "overlayClip"
          ? s.clips
          : kind === "audio"
            ? s.audioClips
            : kind === "text"
              ? s.overlays
              : null;
      if (!pool) throw new ToolError(`Unknown kind: ${kind}`);
      if (!pool.some((x) => x.id === id)) throw new ToolError(`No ${kind} with id ${id}.`);
      const selKind = kind === "overlayClip" ? "clip" : (kind as "clip" | "audio" | "text");
      s.select({ kind: selKind, id });
      return { selection: { kind: selKind, id } };
    }

    case "set_side_panel": {
      const panel = String(input.panel);
      if (panel !== "none" && !SIDE_PANEL_TABS.some((t) => t === panel))
        throw new ToolError(`Unknown panel: ${panel}`);
      requestSidePanel(panel === "none" ? null : (panel as SidePanelTab));
      return { panel };
    }

    case "split_at": {
      const before = s.clips.length + s.audioClips.length;
      s.splitAtPlayhead(isNum(input.t) ? input.t : undefined);
      const after = useEditor.getState();
      const made = after.clips.length + after.audioClips.length - before;
      if (made === 0) throw new ToolError("Nothing to split at that time.");
      return { split: true, videoClips: after.clips.length };
    }

    case "move_clip": {
      const clip = requireItem(s.clips, input.clipId, "video clip");
      // Reordering by index is a base-sequence operation; a layer clip is
      // free-positioned — move it with update_overlay_video (start/track).
      if (clip.track !== 0)
        throw new ToolError(
          "That clip is on an overlay track — use update_overlay_video to move it."
        );
      if (!isNum(input.toIndex)) throw new ToolError("toIndex is required.");
      const row = track0Clips(s.clips);
      s.moveClip(clip.id, clamp(Math.round(input.toIndex), 0, row.length - 1));
      return { order: track0Clips(useEditor.getState().clips).map((c) => c.id) };
    }

    case "place_clip": {
      const clip = requireItem(s.clips, input.clipId, "video clip");
      if (!isNum(input.start)) throw new ToolError("start (seconds) is required.");
      const len = (clip.out - clip.in) / (clip.speed && clip.speed > 0 ? clip.speed : 1);
      const taken = s.clips
        .filter((c) => c.id !== clip.id && c.track === clip.track)
        .map((c) => ({
          start: c.start,
          end: c.start + (c.out - c.in) / (c.speed && c.speed > 0 ? c.speed : 1),
        }));
      const at = nextFreeStart(taken, Math.max(0, input.start), len);
      s.updateClip(clip.id, { start: at });
      useEditor.getState().sortClips();
      return {
        id: clip.id,
        start: round2(at),
        ...(Math.abs(at - Math.max(0, input.start)) > 0.005
          ? { note: "That spot was taken — slid right to the next free one." }
          : {}),
      };
    }

    case "add_clip": {
      const asset = requireItem(s.assets, input.asset_id, "project asset");
      return placeAssetOnTimeline(asset, input);
    }

    case "add_overlay_video": {
      const asset = requireItem(s.assets, input.asset_id, "project asset");
      if (asset.type !== "video" && asset.type !== "image")
        throw new ToolError("Only video or image assets can sit on a video track.");
      const start = isNum(input.start) ? Math.max(0, input.start) : s.currentTime;
      // Tracks stack bottom-up from track 0; overlays live on 1+. A stale
      // negative (the old behind-track model) clamps to the first layer.
      const track = isNum(input.track) ? Math.max(1, Math.round(input.track)) : 1;
      if (isNum(input.track) && Math.round(input.track) === 0)
        throw new ToolError("Track 0 holds the timeline clips — use place_clip for it.");
      s.addVideoFromAsset(asset.id, { kind: "track", track }, start);
      const cur = useEditor.getState();
      const sel = cur.selection;
      const id = sel?.kind === "clip" ? sel.id : null;
      if (!id) throw new ToolError("Could not create the overlay clip.");
      // Same undo step as the add: the layout rides the transient patch.
      if (typeof input.layout === "string")
        cur.updateClipTransient(id, layoutPatch(input.layout));
      const c = useEditor.getState().clips.find((x) => x.id === id)!;
      return {
        id: c.id,
        track: c.track,
        start: round2(c.start),
        len: round2((c.out - c.in) / (c.speed && c.speed > 0 ? c.speed : 1)),
        layout: regionLabel(rectOf(c)),
      };
    }

    case "update_overlay_video": {
      const c = requireItem(overlayLayers(s.clips), input.id, "overlay video clip");
      const asset = s.assets.find((a) => a.id === c.assetId);
      // A still has no source bound, so its clip can stretch to any length.
      const dur = asset?.type === "image" ? Infinity : asset?.duration ?? c.out;
      const patch: Partial<VideoClip> = {};
      if (isNum(input.start)) patch.start = Math.max(0, input.start);
      if (isNum(input.in)) patch.in = clamp(input.in, 0, dur - 0.1);
      if (isNum(input.out)) patch.out = clamp(input.out, 0.1, dur);
      if (patch.in !== undefined || patch.out !== undefined) {
        if ((patch.out ?? c.out) - (patch.in ?? c.in) < 0.1)
          throw new ToolError("Clip must stay at least 0.1s long.");
      }
      if (isNum(input.track)) {
        const track = Math.round(input.track);
        if (track === 0) throw new ToolError("Track 0 holds the timeline clips — overlays are 1 or higher.");
        patch.track = Math.max(1, track);
      }
      if (typeof input.muted === "boolean") patch.muted = input.muted;
      if (typeof input.hidden === "boolean") patch.hidden = input.hidden || undefined;
      if (typeof input.layout === "string") {
        Object.assign(patch, layoutPatch(input.layout));
      } else if (input.region && typeof input.region === "object") {
        const rg = input.region as Record<string, unknown>;
        if (!isNum(rg.x) || !isNum(rg.y) || !isNum(rg.w) || !isNum(rg.h))
          throw new ToolError("region needs numeric x, y, w, h (frame fractions).");
        const w = clamp(rg.w, 0.05, 1);
        const h = clamp(rg.h, 0.05, 1);
        patch.frame = { x: clamp(rg.x, 0, 1 - w), y: clamp(rg.y, 0, 1 - h), w, h };
      }
      if (input.fit === "fit" || input.fit === "fill") patch.fit = input.fit;
      if (isNum(input.speed)) patch.speed = Math.max(SPEED_FLOOR, input.speed);
      if (Object.keys(patch).length === 0) throw new ToolError("Nothing to change.");
      s.updateClip(c.id, patch);
      const next = useEditor.getState().clips.find((x) => x.id === c.id)!;
      return {
        id: next.id,
        track: next.track,
        start: round2(next.start),
        layout: regionLabel(rectOf(next)),
        fit: next.fit ?? "fit",
        muted: next.muted,
        ...(next.hidden ? { hidden: true } : {}),
      };
    }

    case "trim_clip": {
      const clip = requireItem(s.clips, input.clipId, "video clip");
      const asset = s.assets.find((a) => a.id === clip.assetId);
      // A still has no source bound, so its clip can stretch to any length.
      const dur = asset?.type === "image" ? Infinity : asset?.duration ?? clip.out;
      const nextIn = isNum(input.in) ? clamp(input.in, 0, dur - 0.1) : clip.in;
      const nextOut = isNum(input.out) ? clamp(input.out, 0.1, dur) : clip.out;
      if (nextOut - nextIn < 0.1) throw new ToolError("Clip must stay at least 0.1s long.");
      // Trim through the store's resize path so track 0 keeps its no-overlap
      // invariant: extending a clip pushes the following run right.
      s.setClipTrim(clip.id, nextIn, nextOut);
      return { in: nextIn, out: nextOut, len: Math.round((nextOut - nextIn) * 100) / 100 };
    }

    case "set_clip_muted": {
      const clip = requireItem(s.clips, input.clipId, "video clip");
      s.updateClip(clip.id, { muted: Boolean(input.muted) });
      return { muted: Boolean(input.muted) };
    }

    case "set_clip_volume": {
      const clip = requireItem(s.clips, input.clipId, "video clip");
      if (!isNum(input.volume)) throw new ToolError("volume is required (0..1.5).");
      const volume = clamp(input.volume, 0, 1.5);
      s.updateClip(clip.id, { volume: Math.abs(volume - 1) < 1e-4 ? undefined : volume });
      const next = useEditor.getState().clips.find((c) => c.id === clip.id)!;
      return { id: next.id, volume: next.volume ?? 1 };
    }

    case "detach_audio": {
      const id = input.clipId ? String(input.clipId) : s.selection?.kind === "clip" ? s.selection.id : null;
      if (!id) throw new ToolError("Pass clipId or select a video clip first.");
      const clip = requireItem(s.clips, id, "video clip");
      if (clip.muted) throw new ToolError("That clip's audio is muted — nothing to detach.");
      s.select({ kind: "clip", id: clip.id });
      s.detachAudio();
      const asset = s.assets.find((a) => a.id === clip.assetId);
      if (asset) void ensurePeaks(asset);
      const sel = useEditor.getState().selection;
      return { audioClipId: sel?.kind === "audio" ? sel.id : null };
    }

    case "delete_item": {
      const kind = String(input.kind) as "clip" | "overlayClip" | "audio" | "text";
      const id = String(input.id ?? "");
      const pool =
        kind === "clip" || kind === "overlayClip"
          ? s.clips
          : kind === "audio"
            ? s.audioClips
            : s.overlays;
      if (!pool.some((x) => x.id === id)) throw new ToolError(`No ${kind} with id ${id}.`);
      const selKind = kind === "overlayClip" ? "clip" : (kind as "clip" | "audio" | "text");
      s.select({ kind: selKind, id });
      s.deleteSelection();
      return { deleted: { kind: selKind, id } };
    }

    case "remove_gap": {
      if (!isNum(input.at)) throw new ToolError("at (seconds) is required.");
      const track = isNum(input.track) ? input.track : 0;
      const gap = trackGapAt(s.clips, track, input.at);
      if (!gap) throw new ToolError(`No track-${track} gap at ${input.at}s — pass a time inside the empty span.`);
      s.removeGap(track, input.at);
      return { closed: { track, ...gap } };
    }

    case "add_title": {
      if (typeof input.text !== "string" || !input.text.trim())
        throw new ToolError("text is required.");
      if (isNum(input.start)) s.seek(input.start);
      s.addOverlay();
      const cur = useEditor.getState();
      const sel = cur.selection;
      if (sel?.kind !== "text") throw new ToolError("Could not create the title.");
      applyOverlayPatchSettled(sel.id, titlePatch({ ...input, id: sel.id }));
      const o = useEditor.getState().overlays.find((x) => x.id === sel.id)!;
      return { id: o.id, text: o.text, start: o.start, end: o.end };
    }

    case "update_title": {
      const o = requireItem(s.overlays, input.id, "title");
      s.updateOverlay(o.id, titlePatch(input));
      const next = useEditor.getState().overlays.find((x) => x.id === o.id)!;
      return { id: next.id, text: next.text, color: next.color, size: next.size };
    }

    case "update_audio": {
      const a = requireItem(s.audioClips, input.id, "soundtrack clip");
      const aSpeed = a.speed && a.speed > 0 ? a.speed : 1;
      const len = (a.out - a.in) / aSpeed;
      const patch: Partial<AudioClip> = {};
      if (isNum(input.volume)) patch.volume = clamp(input.volume, 0, 1.5);
      if (isNum(input.fadeIn)) patch.fadeIn = clamp(input.fadeIn, 0, len / 2);
      if (isNum(input.fadeOut)) patch.fadeOut = clamp(input.fadeOut, 0, len / 2);
      if (isNum(input.start)) patch.start = Math.max(0, input.start);
      if (isNum(input.in)) patch.in = Math.max(0, input.in);
      if (isNum(input.out)) patch.out = input.out;
      if (isNum(input.speed))
        patch.speed =
          Math.abs(input.speed - 1) < 1e-4 ? undefined : Math.max(SPEED_FLOOR, input.speed);
      // duck >= 1 clears ducking (undefined); below 1 sets the gain.
      if (isNum(input.duck)) patch.duck = input.duck >= 1 ? undefined : clamp(input.duck, 0, 1);
      if (isNum(patch.in ?? NaN) || isNum(patch.out ?? NaN)) {
        const nIn = patch.in ?? a.in;
        const nOut = patch.out ?? a.out;
        if (nOut - nIn < 0.1) throw new ToolError("Audio clip must stay at least 0.1s long.");
      }
      if (!("duck" in patch) && Object.keys(patch).length === 0)
        throw new ToolError("Nothing to change.");
      s.updateAudio(a.id, patch);
      // Report where the clip actually sits: the store slides a committed move
      // to the lane's next free slot when the requested start overlaps.
      const landed = useEditor.getState().audioClips.find((c) => c.id === a.id)!;
      return {
        id: a.id,
        ...patch,
        ...("start" in patch ? { start: round2(landed.start) } : {}),
      };
    }

    case "set_framing": {
      const clip = requireItem(s.clips, input.clipId, "video clip");
      const mode = input.mode === "fill" ? "fill" : "fit";
      s.updateClip(clip.id, {
        fit: mode,
        panX: mode === "fill" && isNum(input.panX) ? clamp(input.panX, -1, 1) : 0,
        panY: mode === "fill" && isNum(input.panY) ? clamp(input.panY, -1, 1) : 0,
      });
      const next = useEditor.getState().clips.find((c) => c.id === clip.id)!;
      return { id: next.id, fit: next.fit, panX: next.panX ?? 0, panY: next.panY ?? 0 };
    }

    case "freeze_frame": {
      const projectId = s.projectId;
      if (!projectId) throw new ToolError("No project open.");
      const spans = getClipSpans(s.clips, s.assets);
      if (spans.length === 0) throw new ToolError("The timeline is empty.");
      const total = totalDuration(s.clips);
      const t = clamp(isNum(input.t) ? input.t : s.currentTime, 0, Math.max(0, total - 0.001));
      const span = spans.find((sp) => t >= sp.start && t < sp.start + sp.len) ?? spans[spans.length - 1];
      const srcTime = span.clip.in + (t - span.start);
      let body: MediaAsset;
      if (getBackend().kind === "cloud") {
        // No engine to bake a still video — grab the frame in the browser and
        // store it as a project image; image clips carry their own length,
        // sized below to the requested duration, mirroring the engine's
        // /freeze clamps (default 1s, 0.5..10s).
        const freezeDur = Math.min(10, Math.max(0.5, isNum(input.duration) ? input.duration : 1));
        body = await captureFreezeFrame(projectId, span.asset.url, srcTime, freezeDur).catch(
          (e) => {
            throw new ToolError(
              e instanceof Error ? e.message : "Could not render the freeze frame."
            );
          }
        );
      } else {
        const res = await apiFetch(`/api/cut/projects/${projectId}/freeze`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            file: span.asset.fileName,
            srcTime,
            duration: isNum(input.duration) ? input.duration : 1,
            // Bake the still at the current project frame, framed exactly as
            // the preview shows it. Switching aspect later letterboxes this
            // still — capture a fresh one to re-fit.
            frame: frameOf(s.aspect),
            framing: {
              fit: span.clip.fit ?? "fit",
              panX: span.clip.panX ?? 0,
              panY: span.clip.panY ?? 0,
            },
          }),
        });
        const made = await apiJson<MediaAsset>(res);
        if (!res.ok) throw new ToolError(made.error ?? "Could not render the freeze frame.");
        body = made;
      }
      const asset: MediaAsset = { ...body, url: mediaUrl(projectId, body.fileName), origin: "freeze" };
      const cur = useEditor.getState();
      cur.addAsset(asset);
      cur.addClipFromAsset(asset.id); // lands at the end, selected
      const sel = useEditor.getState().selection;
      // A cloud freeze is a still image, placed at the default image-clip
      // length — resize it to the requested duration (the engine path bakes a
      // video whose duration addClipFromAsset adopts on its own).
      if (sel?.kind === "clip" && body.type === "image" && body.duration > 0) {
        cur.updateClip(sel.id, { out: body.duration });
      }
      const index = clamp(isNum(input.index) ? Math.round(input.index) : 0, 0, useEditor.getState().clips.length - 1);
      if (sel?.kind === "clip") cur.moveClip(sel.id, index);
      void enrichAsset(asset);
      return {
        assetId: asset.id,
        clipId: sel?.kind === "clip" ? sel.id : null,
        index,
        duration: body.duration,
        from: { time: Math.round(t * 100) / 100, source: span.asset.name },
      };
    }

    case "generate_image": {
      const projectId = s.projectId;
      if (!projectId) throw new ToolError("No project open.");
      const prompt = String(input.prompt ?? "").trim();
      if (!prompt) throw new ToolError("A prompt is required.");
      const refs = resolveRefAssets(input.reference_asset_ids);

      // Captured before the render: the image files under the chat that
      // asked, even if the user switches threads while it generates. Ownership
      // rides the job from creation, so neither the job row nor the landed
      // asset ever touches the Image panel.
      const chatId = chatOwner();
      // Hosted image generation is synchronous and quick, so wait it out.
      const job = await useGenerate.getState().generateImage(projectId, prompt, {
        ...(input.aspect === "16:9" || input.aspect === "9:16" || input.aspect === "1:1"
          ? { aspect: input.aspect }
          : {}),
        ...(input.resolution === "1K" || input.resolution === "2K" || input.resolution === "4K"
          ? { resolution: input.resolution }
          : {}),
        ...(refs.length > 0 ? { refs } : {}),
        ...(chatId ? { chatId } : {}),
      });
      if (job.status !== "done" || !job.assetId) {
        throw new ToolError(job.error ?? "Image generation failed.");
      }
      const cur = useEditor.getState();
      const asset = cur.assets.find((a) => a.id === job.assetId);
      if (!asset) throw new ToolError("The generated image did not land in the project.");
      const placed = wantsTimeline(input, "index")
        ? addVideoTrackClip(asset.id, promptedIndex(input))
        : NOT_PLACED;
      return {
        assetId: asset.id,
        name: asset.name,
        kind: "image",
        // A still has no source length; report its default placed length.
        duration: IMAGE_CLIP_SECONDS,
        addedToTimeline: placed.added,
        clipId: placed.clipId,
        index: placed.index,
      };
    }

    case "generate_video": {
      const projectId = s.projectId;
      if (!projectId) throw new ToolError("No project open.");
      const prompt = String(input.prompt ?? "").trim();
      if (!prompt) throw new ToolError("A prompt is required.");
      const gen = useGenerate.getState();
      // The render is fire-and-forget below, so a signed-out user must be
      // caught here — an unprobed session (null) resolves before we claim
      // success. Deeper errors surface in the panel's job list.
      const signedIn = gen.signedIn ?? (await gen.probeNow());
      if (!signedIn) throw new ToolError("Sign in to Donkey to generate video.");

      // Video renders can outrun the assistant tool bridge's 2-minute cap, so
      // don't block: start the job and let its completion place the clip.
      const refs =
        input.reference_asset_id === undefined
          ? []
          : resolveRefAssets([input.reference_asset_id]);
      // The model renders the whole clip with audio in one pass and picks its
      // own length (up to ~10s) — aspect is the only knob.
      const baseOpts: Omit<VideoGenOptions, "onDone"> = {
        ...(input.aspect === "16:9" || input.aspect === "9:16" ? { aspect: input.aspect } : {}),
      };
      // A one-off render walks the same identity ladder as a scene shot:
      // seed image first (the strongest anchor), the picture as an identity
      // reference second, text-only last — so a safety-blocked anchor
      // degrades the render instead of killing it. The text rung is gated
      // exactly like a scene shot's: it runs only when the provider refused
      // the image anchor itself. An ordinary failure (timeout, 5xx) must
      // fail the job — a render that never saw the user's picture is not a
      // success to show them.
      const asReference = (anchor: AssetRef): VideoAttempt => ({
        prompt,
        opts: { ...baseOpts, referenceImages: [anchor] },
      });
      const textOnly: VideoAttempt = { prompt, opts: { ...baseOpts }, gate: anchorRefused };
      // "Animate this image": the referenced frame is the product, so it seeds
      // the render untouched — no image-model redesign in between, and no
      // text-only rung (a render without the image isn't what was asked).
      if (refs.length > 0 && input.animate_reference === true) {
        return launchVideoJob(
          projectId,
          input,
          [
            { prompt, opts: { ...baseOpts, refs: [refs[0]], composeRefs: false } },
            asReference(refs[0]),
          ],
          {
            note: "Animating the referenced image as the literal opening frame — the clip previews in this chat when it lands, in a minute or two.",
          }
        );
      }
      // Staged, like the scene pipeline: reference work happens in the image
      // model first — it holds identity far better than any video model — and
      // the video model then animates the approved frame. The still lands as
      // a chat asset (its card previews above the render's), and the render
      // seeds from it with the prompt as written. Text-only asks skip
      // straight to video; a failed still degrades to the composed-seed hop.
      if (refs.length > 0) {
        const still = await gen.generateImage(projectId, prompt, {
          refs,
          aspect:
            input.aspect === "16:9" || input.aspect === "9:16"
              ? input.aspect
              : nearestAspect(useEditor.getState().aspect, defaultVideoAspects()),
          chatId: chatOwner() ?? undefined,
        });
        const stillAsset =
          still.status === "done" && still.assetId
            ? useEditor.getState().assets.find((a) => a.id === still.assetId)
            : undefined;
        if (stillAsset) {
          return launchVideoJob(
            projectId,
            input,
            [
              { prompt, opts: { ...baseOpts, refs: [refFromAsset(stillAsset)], composeRefs: false } },
              asReference(refs[0]),
              textOnly,
            ],
            {
              extra: { stillAssetId: stillAsset.id },
              note: "Designed the opening frame from the reference first (the image card above the render), then started the video from that exact frame — it previews in this chat when it lands, in a minute or two.",
            }
          );
        }
        return launchVideoJob(projectId, input, [
          { prompt, opts: { ...baseOpts, refs } },
          asReference(refs[0]),
          textOnly,
        ]);
      }
      // No reference: text is the whole request, so the single rung runs ungated.
      return launchVideoJob(projectId, input, [{ prompt, opts: { ...baseOpts } }]);
    }

    case "wait_for_renders": {
      const projectId = s.projectId;
      if (!projectId) throw new ToolError("No project open.");
      const watched = useGenerate
        .getState()
        .jobs.filter(
          (j) => j.kind === "video" && j.status === "running" && j.projectId === projectId
        )
        .map((j) => j.id);
      if (watched.length === 0) {
        return { renders: [], note: "No renders in flight — check `renders` in the state for recent outcomes." };
      }
      // Poll the job store rather than the settlement promises: it also tracks
      // renders another tab owns. Stay under the tool bridge's 2-minute cap;
      // whatever hasn't settled reports as still rendering.
      const deadline = Date.now() + 100_000;
      while (Date.now() < deadline) {
        const jobs = useGenerate.getState().jobs;
        if (!watched.some((id) => jobs.find((j) => j.id === id)?.status === "running")) break;
        await new Promise((r) => setTimeout(r, 1000));
      }
      const jobs = useGenerate.getState().jobs;
      const cur = useEditor.getState();
      const renders = watched.map((id) => {
        const j = jobs.find((x) => x.id === id);
        if (!j) return { jobId: id, status: "dismissed" as const };
        const asset = j.assetId ? cur.assets.find((a) => a.id === j.assetId) : undefined;
        return {
          jobId: id,
          status: j.status,
          ...(asset ? { assetId: asset.id, name: asset.name, duration: asset.duration } : {}),
          ...(j.status === "error" && j.error ? { error: j.error } : {}),
        };
      });
      const stillRunning = renders.filter((x) => x.status === "running").length;
      return {
        renders,
        ...(stillRunning > 0
          ? { note: `${stillRunning} still rendering — call wait_for_renders again to keep waiting.` }
          : {}),
      };
    }

    case "generate_character_video": {
      const projectId = s.projectId;
      if (!projectId) throw new ToolError("No project open.");
      const id = String(input.character_id ?? "");
      const character = STOCK_VIDEOS.find((v) => v.id === id && v.persona);
      if (!character)
        throw new ToolError(`No talking character with id ${id}. Call stock_search kind:"character".`);
      const line = String(input.line ?? "").trim();
      if (!line) throw new ToolError("line is required — what should they say?");
      const gen = useGenerate.getState();
      const signedIn = gen.signedIn ?? (await gen.probeNow());
      if (!signedIn) throw new ToolError("Sign in to Donkey to generate video.");
      return launchVideoJob(
        projectId,
        input,
        [
          {
            prompt: characterPrompt(character.persona!, line),
            opts: {
              aspect: character.aspect,
              // The character's own clip seeds the render so the same person
              // delivers the line — composing would swap the face, so it rides
              // raw, and there is no weaker rung: another anchor is another face.
              refs: [refFromStockVideo(character)],
              composeRefs: false,
            },
          },
        ],
        { extra: { character: character.id } }
      );
    }

    case "generate_scene": {
      const projectId = s.projectId;
      if (!projectId) throw new ToolError("No project open.");
      const gen = useGenerate.getState();
      const signedIn = gen.signedIn ?? (await gen.probeNow());
      if (!signedIn) throw new ToolError("Sign in to Donkey to generate a video.");
      const brief = String(input.brief ?? "").trim();
      const fromAudio =
        input.from_audio_asset_id !== undefined ? String(input.from_audio_asset_id) : undefined;
      if (!brief && !fromAudio)
        throw new ToolError("A brief is required (or from_audio_asset_id to animate existing audio).");
      if (fromAudio) {
        const asset = s.assets.find((a) => a.id === fromAudio);
        const audio = s.assets.filter((a) => a.type === "audio");
        const hint = audio.length
          ? ` The project's audio: ${audio.map((a) => `${a.id} ("${a.name}")`).join(", ")}.`
          : " This project has no audio asset — omit from_audio_asset_id to write a fresh narration instead.";
        if (!asset) throw new ToolError(`No project asset with id ${fromAudio}.${hint}`);
        if (asset.type !== "audio")
          throw new ToolError(`"${asset.name}" is ${asset.type}, not audio — from_audio_asset_id must be the audio to animate.${hint}`);
        // The scene transcriber keys its recognizer off asset.language; a
        // mismatched recognizer turns foreign speech into garbage the plan
        // then depicts.
        const lang = typeof input.audio_language === "string" ? input.audio_language.trim() : "";
        if (lang) s.updateAsset(fromAudio, { language: lang });
      }
      // Plan up to the shot list and stop; approve_scene starts the paid renders.
      // Tag every asset the run creates to the asking chat, so intermediates and
      // shots stay off the Media/Video/Image/Audio panels.
      const res = await useGenScene.getState().start(projectId, {
        chatId: chatOwner(),
        ...(brief ? { brief } : {}),
        ...(fromAudio ? { fromAudioAssetId: fromAudio } : {}),
        ...(isNum(input.target_seconds)
          ? { targetSeconds: clamp(Math.round(input.target_seconds), 6, 90) }
          : {}),
        ...(typeof input.style === "string" && input.style.trim() ? { style: input.style.trim() } : {}),
        ...(Array.isArray(input.reference_asset_ids)
          ? { referenceAssetIds: input.reference_asset_ids.map(String) }
          : {}),
      });
      if (!res.started) throw new ToolError(res.message);
      return {
        planned: true,
        shots: res.shotCount,
        note: `${res.message} A storyboard card below shows each shot's opening frame for the user, so keep your reply to one short line — don't re-describe the shots or the timing. Ask them to review it; if they want a frame changed, call regenerate_shot (at this stage it just redraws that frame, no credits). When they approve, call approve_scene — that starts the paid video renders, so don't approve on your own.`,
      };
    }

    case "approve_scene": {
      const res = useGenScene.getState().approve();
      if (!res.ok) throw new ToolError(res.message);
      return { rendering: true, note: res.message };
    }

    case "cancel_scene": {
      const res = useGenScene.getState().cancel();
      if (!res.ok) throw new ToolError(res.message);
      return { stopped: true, note: res.message };
    }

    case "regenerate_shot": {
      if (!isNum(input.n)) throw new ToolError("n (the 1-based shot number) is required.");
      const note = typeof input.note === "string" && input.note.trim() ? input.note.trim() : undefined;
      const res = useGenScene.getState().regenerateShot(Math.round(input.n), note);
      if (!res.ok) throw new ToolError(res.message);
      return { note: res.message };
    }

    case "recut_scene": {
      if (!isNum(input.from_shot) || !isNum(input.to_shot))
        throw new ToolError("from_shot and to_shot (1-based, inclusive) are required.");
      const instruction = String(input.instruction ?? "").trim();
      if (!instruction) throw new ToolError("An instruction is required — what should this span become?");
      const res = useGenScene
        .getState()
        .recutShots(Math.round(input.from_shot), Math.round(input.to_shot), instruction);
      if (!res.ok) throw new ToolError(res.message);
      return { note: res.message };
    }

    case "restyle_scene": {
      const style = String(input.style ?? "").trim();
      if (!style) throw new ToolError("style is required — the new look for the whole video.");
      const res = useGenScene.getState().restyle(style);
      if (!res.ok) throw new ToolError(res.message);
      return { note: res.message };
    }

    case "stock_search": {
      const q = String(input.query ?? "").trim().toLowerCase();
      const kindIn =
        input.kind === "video" || input.kind === "image" || input.kind === "character"
          ? input.kind
          : undefined;
      interface Hit {
        id: string;
        kind: "video" | "image" | "character";
        category: string;
        aspect: string;
        duration?: number;
        persona?: string;
        prompt: string;
        tags: string[];
      }
      const hits: Hit[] = [];
      for (const v of STOCK_VIDEOS) {
        const kind = v.category === "Characters" ? "character" : "video";
        if (kindIn && kindIn !== kind) continue;
        hits.push({
          id: v.id,
          kind,
          category: v.category,
          aspect: v.aspect,
          duration: round2(v.duration),
          ...(v.persona ? { persona: v.persona } : {}),
          prompt: v.prompt,
          tags: v.tags,
        });
      }
      if (!kindIn || kindIn === "image") {
        for (const i of STOCK_IMAGES) {
          hits.push({
            id: i.id,
            kind: "image",
            category: i.category,
            aspect: i.aspect,
            prompt: i.prompt,
            tags: i.tags,
          });
        }
      }
      const words = q.split(/\s+/).filter(Boolean);
      const matches = hits.filter((h) => {
        const hay = [h.id, h.category, h.prompt, h.persona ?? "", ...h.tags]
          .join(" ")
          .toLowerCase();
        return words.every((w) => hay.includes(w));
      });
      const trim = (t: string, n: number) => (t.length > n ? `${t.slice(0, n - 1)}…` : t);
      return {
        results: matches.slice(0, 12).map((h) => ({
          ...h,
          prompt: trim(h.prompt, 160),
          ...(h.persona ? { persona: trim(h.persona, 160) } : {}),
          tags: h.tags.slice(0, 6),
        })),
        total: matches.length,
        ...(matches.length > 12 ? { truncated: true } : {}),
      };
    }

    case "stock_add": {
      const projectId = s.projectId;
      if (!projectId) throw new ToolError("No project open.");
      const id = String(input.id ?? "");
      const vid = STOCK_VIDEOS.find((v) => v.id === id);
      const img = vid ? undefined : STOCK_IMAGES.find((i) => i.id === id);
      if (!vid && !img)
        throw new ToolError(`No stock item with id ${id}. Call stock_search for ids.`);
      // Captured before the import: the media files under the chat that
      // asked, even if the user switches threads while it downloads.
      const chatId = chatOwner();
      const asset = vid
        ? await importStockVideo(projectId, { url: vid.file, name: stockTitle(vid.id) })
        : await importImage(projectId, { url: img!.file, name: stockTitle(img!.id) });
      tagChatAsset(asset.id, chatId);
      const addToTimeline = wantsTimeline(input, "start");
      let clipId: string | null = null;
      if (addToTimeline) {
        useEditor
          .getState()
          .addClipFromAsset(asset.id, isNum(input.start) ? Math.max(0, input.start) : undefined);
        const sel = useEditor.getState().selection;
        clipId = sel?.kind === "clip" ? sel.id : null;
      }
      return {
        assetId: asset.id,
        name: asset.name,
        kind: vid ? "video" : "image",
        duration: round2(vid ? asset.duration : IMAGE_CLIP_SECONDS),
        addedToTimeline: addToTimeline,
        clipId,
      };
    }

    case "import_url": {
      const projectId = s.projectId;
      if (!projectId) throw new ToolError("No project open.");
      const url = String(input.url ?? "").trim();
      if (!url) throw new ToolError("A URL is required.");
      // Captured before the download: the media files under the chat that
      // asked, even if the user switches threads while it downloads.
      const chatId = chatOwner();
      const { assets, text } = await importUrlMedia(projectId, url);
      for (const asset of assets) tagChatAsset(asset.id, chatId);
      return {
        assets: assets.map((asset) => ({
          assetId: asset.id,
          name: asset.name,
          kind: asset.type,
          duration: round2(asset.type === "image" ? IMAGE_CLIP_SECONDS : asset.duration),
        })),
        ...(text ? { sourceText: text } : {}),
      };
    }

    case "library_list": {
      const lib = await fetchLibrary();
      return {
        folders: lib.folders.map((f) => ({ id: f.id, name: f.name })),
        assets: lib.assets.map((a) => ({
          id: a.id,
          name: a.name,
          kind: a.type,
          duration: round2(a.duration),
          ...(a.folderId ? { folderId: a.folderId } : {}),
        })),
        templates: lib.templates.map((t) => ({
          id: t.id,
          name: t.name,
          duration: round2(t.duration),
          parts: t.layers.length + t.audio.length + t.texts.length + t.cues.length,
        })),
      };
    }

    case "library_add": {
      const projectId = s.projectId;
      if (!projectId) throw new ToolError("No project open.");
      const lib = (await fetchLibrary()).assets.find((a) => a.id === String(input.id ?? ""));
      if (!lib)
        throw new ToolError(`No library asset with id ${String(input.id)}. Call library_list for ids.`);
      // Captured before the import: the media files under the chat that asked,
      // even if the user switches threads while it copies.
      const chatId = chatOwner();
      const asset = await importLibraryAsset(projectId, lib);
      tagChatAsset(asset.id, chatId);
      const place =
        input.add_to_timeline === true || isNum(input.start) || isNum(input.index);
      return {
        assetId: asset.id,
        name: asset.name,
        kind: asset.type,
        duration: round2(asset.type === "image" ? IMAGE_CLIP_SECONDS : asset.duration),
        ...(place
          ? { addedToTimeline: true, clip: placeAssetOnTimeline(asset, input) }
          : { addedToTimeline: false }),
      };
    }

    case "template_add": {
      const projectId = s.projectId;
      if (!projectId) throw new ToolError("No project open.");
      const t = (await fetchLibrary()).templates.find((x) => x.id === String(input.id ?? ""));
      if (!t)
        throw new ToolError(`No template with id ${String(input.id)}. Call library_list for ids.`);
      const chatId = chatOwner();
      const before = new Set(s.assets.map((a) => a.id));
      await addTemplateToProject(projectId, t);
      // Chat-fetched media files under the asking thread, like stock/library
      // imports; the template's clips reference it, so it survives cleanup.
      for (const a of useEditor.getState().assets) {
        if (!before.has(a.id)) tagChatAsset(a.id, chatId);
      }
      return {
        added: t.name,
        duration: round2(t.duration),
        parts: t.layers.length + t.audio.length + t.texts.length + t.cues.length,
      };
    }

    case "save_template": {
      if (!s.projectId) throw new ToolError("No project open.");
      const name = String(input.name ?? "").trim();
      if (!name) throw new ToolError("A template name is required.");
      const ids = Array.isArray(input.item_ids) ? input.item_ids.map(String) : [];
      if (ids.length === 0) throw new ToolError("item_ids is required — the timeline items to save.");
      const sels = ids.map((id): NonNullable<Selection> => {
        if (s.clips.some((c) => c.id === id)) return { kind: "clip", id };
        if (s.audioClips.some((c) => c.id === id)) return { kind: "audio", id };
        if (s.overlays.some((o) => o.id === id)) return { kind: "text", id };
        if (s.subtitles.cues.some((c) => c.id === id)) return { kind: "cue", id };
        throw new ToolError(`No timeline item with id ${id}. Call get_state for current ids.`);
      });
      // Build through the store's selection-template path — the same shape the
      // user's Save-selection button produces — leaving the items selected.
      s.select(sels[0]);
      for (const sel of sels.slice(1)) s.toggleSelect(sel);
      const built = useEditor.getState().selectionTemplate();
      if (!built) throw new ToolError("Could not build a template from those items.");
      const saved = useEditor.getState().addTemplate({ ...built, name });
      return { id: saved.id, name: saved.name, duration: round2(saved.duration) };
    }

    case "library_organize": {
      // The library spans both shelves, so every id is resolved against the
      // current listing to find the backend that owns it.
      const lib = await fetchLibrary();
      const folderShelf = (id: string) => lib.folders.find((f) => f.id === id)?.residency;
      const itemShelf = (id: string) =>
        lib.assets.find((a) => a.id === id)?.residency ??
        lib.templates.find((t) => t.id === id)?.residency;
      switch (String(input.action ?? "")) {
        case "create_folder": {
          const name = String(input.name ?? "").trim();
          if (!name) throw new ToolError("A folder name is required.");
          const f = await createLibraryFolder(name);
          return { folderId: f.id, name: f.name };
        }
        case "rename_folder": {
          const name = String(input.name ?? "").trim();
          if (!name) throw new ToolError("A folder name is required.");
          const id = String(input.folder_id ?? "");
          const r = folderShelf(id);
          if (!r) throw new ToolError(`No library folder with id ${id}.`);
          await renameLibraryFolder(r, id, name);
          return { renamed: true, name };
        }
        case "delete_folder": {
          const id = String(input.folder_id ?? "");
          const r = folderShelf(id);
          if (!r) throw new ToolError(`No library folder with id ${id}.`);
          await deleteLibraryFolder(r, id);
          return { deleted: true, note: "Its assets moved to the Library root." };
        }
        case "move_asset": {
          const folderId =
            typeof input.folder_id === "string" && input.folder_id ? input.folder_id : null;
          const id = String(input.id ?? "");
          const r = itemShelf(id);
          if (!r) throw new ToolError(`No library item with id ${id}.`);
          if (folderId && folderShelf(folderId) !== r) {
            throw new ToolError("That folder is on the other library shelf.");
          }
          await moveLibraryItem(r, id, folderId);
          return { moved: true, folderId };
        }
        case "delete_asset": {
          const id = String(input.id ?? "");
          const r = lib.assets.find((a) => a.id === id)?.residency;
          if (!r) throw new ToolError(`No library asset with id ${id}.`);
          await deleteFromLibrary(r, id);
          return { deleted: true };
        }
        case "delete_template": {
          const id = String(input.id ?? "");
          const r = lib.templates.find((t) => t.id === id)?.residency;
          if (!r) throw new ToolError(`No library template with id ${id}.`);
          await deleteTemplate(r, id);
          return { deleted: true };
        }
        default:
          throw new ToolError(`Unknown action "${String(input.action)}".`);
      }
    }

    case "file_asset": {
      const asset = requireItem(s.assets, input.asset_id, "project asset");
      if (input.to === "media") {
        s.updateAsset(asset.id, { origin: undefined, chatId: undefined });
        return { filed: "media", name: asset.name };
      }
      if (input.to === "library") {
        const projectId = s.projectId;
        if (!projectId) throw new ToolError("No project open.");
        const saved = await saveAssetToLibrary(projectId, asset);
        return { filed: "library", libraryId: saved.id, name: saved.name };
      }
      throw new ToolError('`to` must be "media" or "library".');
    }

    case "delete_asset": {
      const asset = requireItem(s.assets, input.asset_id, "project asset");
      const uses =
        s.clips.filter((c) => c.assetId === asset.id).length +
        s.audioClips.filter((c) => c.assetId === asset.id).length;
      s.removeAsset(asset.id);
      return { removed: asset.name, clipsRemoved: uses };
    }

    case "subtitles_generate": {
      const lane = targetSubtitleTrack(input);
      if (typeof input.locale === "string" && input.locale)
        useEditor.getState().setSubtitleTrackMeta(lane, { locale: input.locale });
      await useEditor.getState().generateSubtitles();
      const cur = useEditor.getState();
      if (cur.subtitleStatus === "error")
        throw new ToolError(cur.subtitleError ?? "Transcription failed.");
      const made = laneCues(cur.subtitles, lane).length;
      if (made > 0 && cur.timelineH < 276) cur.setTimelineH(276);
      return {
        status: cur.subtitleStatus,
        track: lane,
        cues: made,
        note:
          cur.subtitleStatus === "empty"
            ? "No speech found — no subtitles were added to the video."
            : undefined,
      };
    }

    case "captions_generate": {
      const raw = typeof input.style === "string" ? input.style : "hook";
      const style = (["clean", "hook", "punchy"].includes(raw) ? raw : "hook") as
        | "clean"
        | "hook"
        | "punchy";
      const lane = targetSubtitleTrack(input);
      await useEditor.getState().generateCaptions(style);
      const cur = useEditor.getState();
      if (cur.subtitleStatus === "error")
        throw new ToolError(cur.subtitleError ?? "Captions failed.");
      const made = laneCues(cur.subtitles, lane).length;
      if (made > 0 && cur.timelineH < 276) cur.setTimelineH(276);
      return {
        status: cur.subtitleStatus,
        track: lane,
        cues: made,
        style: cur.subtitles.style,
        note:
          cur.subtitleStatus === "empty"
            ? "No speech found — no captions were added to the video."
            : undefined,
      };
    }

    case "subtitles_from_visuals": {
      const lane = targetSubtitleTrack(input);
      if (typeof input.locale === "string" && input.locale)
        useEditor.getState().setSubtitleTrackMeta(lane, { locale: input.locale });
      await useEditor.getState().generateVisualSubtitles();
      const cur = useEditor.getState();
      if (cur.subtitleStatus === "error")
        throw new ToolError(cur.subtitleError ?? "Visual captioning failed.");
      const made = laneCues(cur.subtitles, lane).length;
      if (made > 0 && cur.timelineH < 276) cur.setTimelineH(276);
      return { status: cur.subtitleStatus, track: lane, cues: made };
    }

    case "subtitles_add_track": {
      const count = subtitleLaneCount(s.subtitles);
      if (count >= MAX_SUBTITLE_LANES)
        throw new ToolError(`Already at ${MAX_SUBTITLE_LANES} subtitle tracks.`);
      s.addSubtitleTrack(
        typeof input.language === "string" && input.language.trim()
          ? input.language.trim()
          : undefined
      );
      return { track: count, tracks: count + 1 };
    }

    case "subtitles_remove_track": {
      if (!isNum(input.track)) throw new ToolError("track is required.");
      const lane = Math.round(input.track);
      const count = subtitleLaneCount(s.subtitles);
      if (lane < 0 || lane >= count) throw new ToolError(`No subtitle track ${lane}.`);
      if (count <= 1) {
        // The editor always keeps one lane, so removing the only track
        // empties it instead.
        const cleared = laneCues(s.subtitles, 0).length;
        s.removeSubtitleTrack(0);
        return { track: 0, tracks: 1, clearedCues: cleared };
      }
      s.removeSubtitleTrack(lane);
      return { removed: lane, tracks: count - 1 };
    }

    case "subtitles_translate_track": {
      const language = typeof input.language === "string" ? input.language.trim() : "";
      if (!language) throw new ToolError("language (BCP-47, e.g. ko-KR) is required.");
      const subs = s.subtitles;
      const count = subtitleLaneCount(subs);
      const localeOf = (i: number) =>
        subs.tracks?.[i]?.locale ?? (i === 0 ? subs.locale : undefined);
      const hasCues = (i: number) => laneCues(subs, i).length > 0;
      const lanes = Array.from({ length: count }, (_, i) => i);
      const from = isNum(input.from_track)
        ? Math.round(input.from_track)
        : lanes.find(hasCues) ?? -1;
      if (from < 0 || from >= count || !hasCues(from))
        throw new ToolError("No captions to translate — generate subtitles first.");
      // Reuse the track already set to this language, else add one.
      let target = lanes.find((i) => i !== from && localeOf(i) === language) ?? -1;
      if (target < 0) {
        if (count >= MAX_SUBTITLE_LANES)
          throw new ToolError(
            `Already at ${MAX_SUBTITLE_LANES} subtitle tracks — remove one first.`
          );
        s.addSubtitleTrack(language);
        target = count;
      }
      const st = useEditor.getState();
      st.setSubtitleLane(target);
      st.setSubtitleTrackMeta(target, { locale: language });
      await useEditor.getState().translateSubtitleTrack(from);
      const cur = useEditor.getState();
      if (cur.subtitleStatus === "error")
        throw new ToolError(cur.subtitleError ?? "Translation failed.");
      if (cur.timelineH < 276) cur.setTimelineH(276);
      return {
        track: target,
        language,
        from,
        cues: laneCues(cur.subtitles, target).length,
      };
    }

    case "list_voices": {
      // Gemini's prebuilt voice catalog is fixed and ships hardcoded.
      return {
        voices: SPEECH_VOICES.map((v) => ({ name: v.name, style: v.style })),
        total: SPEECH_VOICES.length,
      };
    }

    case "voiceover_generate": {
      if (typeof input.script !== "string" || !input.script.trim())
        throw new ToolError("script is required.");
      const start = isNum(input.start) ? Math.max(0, input.start) : s.currentTime;
      // Label with the spoken line (capped) so its preview fills across the row.
      const lead = input.script.replace(/\s+/g, " ").trim().slice(0, 200);
      const place = wantsTimeline(input, "start");
      return synthesizeVoiceover(
        [{ text: input.script, at: 0 }],
        `AI voice — ${lead}`,
        start,
        input,
        place
      );
    }

    case "generate_music": {
      const projectId = s.projectId;
      if (!projectId) throw new ToolError("No project open.");
      const prompt = String(input.prompt ?? "").trim();
      if (!prompt) throw new ToolError("A prompt is required.");
      const gen = useGenerate.getState();
      // An unprobed session (null) resolves before we spend the user's credits.
      const signedIn = gen.signedIn ?? (await gen.probeNow());
      if (!signedIn) throw new ToolError("Sign in to Donkey to generate music.");
      const variant = input.length === "song" ? "song" : "clip";
      // Default to a vocal-free bed; the model opts into a sung song explicitly.
      const instrumental = input.instrumental !== false;
      // References ("match this audio", "the tone of this video"): the music
      // model reads only text, so a multimodal pass listens to/looks at each
      // reference and folds a description of its sound into the prompt. A failed
      // compose falls back to the raw prompt so the render still happens. Keep
      // the user's own words as the track name — the composed prompt is verbose.
      const refs = resolveMusicRefs(input.reference_asset_ids);
      let sent = prompt;
      if (refs.length > 0) {
        const composed = await composeMusicPrompt(prompt, refs);
        if (composed) sent = composed;
      }
      // Captured before synthesis: the track files under the chat that asked,
      // even if the user switches threads while it renders.
      const chatId = chatOwner();
      const asset = await synthesizeMusic(projectId, sent, {
        variant,
        instrumental,
        ...(sent !== prompt ? { name: prompt } : {}),
      });
      const cur = useEditor.getState();
      // The render can outlast the open project: if the user switched away while
      // it ran, save it into the project it was made for — never the one now on
      // screen — and don't touch the current store.
      if (cur.projectId !== projectId) {
        // Stamp chat ownership before persisting — the render outlived the open
        // project, but it still belongs to the thread that asked, exactly as the
        // still-open path tags it (and as generate.ts persists chat renders).
        applyOwnership(asset, chatId);
        void stockAssetInDoc(projectId, asset).catch(() => {});
        return {
          assetId: asset.id,
          name: asset.name,
          duration: round2(asset.duration),
          addedToTimeline: false,
          note: "The music finished and was saved to the project it was generated for; the user has since switched projects, so it isn't on this one.",
        };
      }
      cur.addAsset(asset);
      tagChatAsset(asset.id, chatId);
      void enrichAsset(asset);
      if (!wantsTimeline(input, "start")) {
        return {
          assetId: asset.id,
          name: asset.name,
          duration: round2(asset.duration),
          addedToTimeline: false,
          note: "The music previews in this chat — the user can play it and drag it onto the soundtrack; pass add_to_timeline or start when they ask for it in the cut.",
        };
      }
      const start = isNum(input.start) ? Math.max(0, input.start) : cur.currentTime;
      cur.addAudioFromAsset(asset.id, start);
      // Sits under speech at a soft bed volume by default; the model can raise it.
      const volume = isNum(input.volume) ? clamp(input.volume, 0, 1.5) : 0.4;
      const sel = useEditor.getState().selection;
      const clipId = sel?.kind === "audio" ? sel.id : null;
      if (clipId) useEditor.getState().updateAudio(clipId, { volume });
      // Report where the clip actually landed: addAudioFromAsset slides it to the
      // next free slot on the soundtrack when the requested start overlaps
      // existing audio, so `start` is not necessarily where it sits.
      const placed = clipId
        ? useEditor.getState().audioClips.find((c) => c.id === clipId)
        : undefined;
      const placedStart = placed?.start ?? start;
      return {
        assetId: asset.id,
        name: asset.name,
        audioClipId: clipId,
        start: round2(placedStart),
        duration: round2(asset.duration),
        volume,
        addedToTimeline: true,
      };
    }

    case "read_subtitles_aloud": {
      const lane = targetSubtitleTrack(input);
      if (!laneCues(useEditor.getState().subtitles, lane).some((c) => c.text.trim()))
        throw new ToolError("No subtitles on that track — generate subtitles first.");
      const voice = resolveVoice(typeof input.voice === "string" ? input.voice : undefined);
      // The shared readout also re-times the cues to the generated voice's
      // pace, keeping the word highlighter in step.
      const out = await generateSubtitlesReadout(voice, {
        direction:
          typeof input.direction === "string" && input.direction.trim()
            ? input.direction.trim()
            : undefined,
        language: typeof input.language === "string" ? input.language : undefined,
        duck: isNum(input.duck) ? clamp(input.duck, 0, 1) : undefined,
      });
      const sel = useEditor.getState().selection;
      return {
        assetId: out.asset.id,
        name: out.asset.name,
        audioClipId: sel?.kind === "audio" ? sel.id : null,
        voice,
        start: round2(out.start),
        duration: round2(out.asset.duration),
        duck: out.duck,
        lines: out.lines,
      };
    }

    case "subtitles_set_view": {
      const patch: { showOnVideo?: boolean; showOnTimeline?: boolean } = {};
      if (typeof input.showOnVideo === "boolean") patch.showOnVideo = input.showOnVideo;
      if (typeof input.showOnTimeline === "boolean") patch.showOnTimeline = input.showOnTimeline;
      s.setSubtitlesView(patch);
      if (patch.showOnTimeline && s.subtitles.cues.length > 0 && s.timelineH < 276) s.setTimelineH(276);
      return patch;
    }

    case "update_cue": {
      const cue = requireItem(s.subtitles.cues, input.id, "subtitle cue");
      if (typeof input.text === "string") s.setCueText(cue.id, input.text);
      if (isNum(input.start) || isNum(input.end)) {
        const start = isNum(input.start) ? Math.max(0, input.start) : cue.start;
        const end = isNum(input.end) ? input.end : cue.end;
        if (end - start < 0.15) throw new ToolError("Cue must stay at least 0.15s long.");
        s.setCueTiming(cue.id, start, end);
      }
      const next = useEditor.getState().subtitles.cues.find((c) => c.id === cue.id);
      return next ? { id: next.id, start: next.start, end: next.end, text: next.text } : { deleted: cue.id };
    }

    case "delete_cue": {
      const cue = requireItem(s.subtitles.cues, input.id, "subtitle cue");
      s.deleteCue(cue.id);
      return { deleted: cue.id };
    }

    case "set_publish": {
      const patch: Record<string, string> = {};
      for (const k of ["caption", "tags", "soundTitle", "handle"] as const) {
        if (typeof input[k] === "string") patch[k] = input[k] as string;
      }
      if (Object.keys(patch).length === 0) throw new ToolError("Nothing to change.");
      s.setPublish(patch);
      return patch;
    }

    case "set_view": {
      const out: Record<string, number> = {};
      if (input.fit) {
        const el = document.querySelector<HTMLElement>(".tl-scroll");
        const dur = totalDuration(s.clips);
        if (el && dur > 0) {
          s.setPxPerSec((el.clientWidth - 60) / dur);
          el.scrollLeft = 0;
        }
        out.pxPerSec = useEditor.getState().pxPerSec;
      } else if (isNum(input.pxPerSec)) {
        s.setPxPerSec(input.pxPerSec);
        out.pxPerSec = useEditor.getState().pxPerSec;
      }
      if (isNum(input.timelineH)) {
        s.setTimelineH(clamp(input.timelineH, TIMELINE_H_MIN, TIMELINE_H_MAX));
        out.timelineH = useEditor.getState().timelineH;
      }
      return out;
    }

    case "undo":
      s.undo();
      return { ok: true };
    case "redo":
      s.redo();
      return { ok: true };

    case "open_export": {
      if (getClipSpans(s.clips, s.assets).length === 0)
        throw new ToolError("Add a video to the timeline first.");
      s.setExportOpen(true);
      return { open: true };
    }

    case "set_speed": {
      const clip = requireItem(s.clips, input.clipId, "video clip");
      if (!isNum(input.speed)) throw new ToolError("speed is required (e.g. 1.5).");
      s.setClipSpeed(clip.id, input.speed);
      const next = useEditor.getState().clips.find((c) => c.id === clip.id)!;
      return { id: next.id, speed: next.speed ?? 1 };
    }

    case "set_color_grade": {
      const clip = requireItem(s.clips, input.clipId, "video clip");
      let grade: ColorGrade = input.reset === true ? {} : { ...clip.grade };
      if (input.auto === true) {
        const data = sampleClipFrameData(clip.id);
        if (!data)
          throw new ToolError(
            "No decoded frame for that clip yet — seek into it so it is on screen, then retry."
          );
        grade = { ...autoGradeFromImageData(data) };
      }
      for (const k of GRADE_KEYS) if (isNum(input[k])) grade[k] = input[k];
      s.updateClip(clip.id, { grade: normalizeGrade(grade) });
      const next = useEditor.getState().clips.find((c) => c.id === clip.id)!;
      return { id: next.id, grade: next.grade ?? "neutral" };
    }

    case "set_transition": {
      const clip = requireItem(s.clips, input.clipId, "video clip");
      // A transition joins a clip to the next one on its own track.
      const row = s.clips.filter((c) => c.track === clip.track);
      if (row.findIndex((c) => c.id === clip.id) === row.length - 1)
        throw new ToolError("That is its track's last clip — nothing after it to transition into.");
      if (!isNum(input.seconds)) throw new ToolError("seconds is required (0 clears the transition).");
      let style: TransitionStyle | undefined;
      if (input.style !== undefined) {
        const requested = TRANSITION_STYLE_SYNONYMS[input.style as string] ?? input.style;
        style = TRANSITION_STYLE_IDS.find((x) => x === requested);
        if (!style) throw new ToolError(`Unknown style. Use one of: ${TRANSITION_STYLE_IDS.join(", ")}.`);
      }
      s.setClipTransition(clip.id, input.seconds, style);
      const next = useEditor.getState().clips.find((c) => c.id === clip.id)!;
      return { id: next.id, transition: next.transition ?? 0, style: next.transitionStyle ?? "crossfade" };
    }

    case "set_animation": {
      const clip = requireItem(s.clips, input.clipId, "video clip");
      const which = input.which === "in" || input.which === "out" ? input.which : null;
      if (!which) throw new ToolError('which must be "in" or "out".');
      if (input.style === "none") {
        s.setClipAnim(clip.id, which, null);
        return { id: clip.id, which, style: "none" };
      }
      const requested = ANIM_STYLE_SYNONYMS[input.style as string] ?? input.style;
      const style = ANIM_STYLE_IDS.find((x) => x === requested);
      if (!style)
        throw new ToolError(`Unknown style. Use one of: ${ANIM_STYLE_IDS.join(", ")}, none.`);
      if (clip.track > 0 && overlayAnimStyle(style) !== style)
        throw new ToolError("Upper-track clips animate with fade or zoom only.");
      const seconds = isNum(input.seconds) ? input.seconds : ANIM_DEFAULT_SECONDS;
      s.setClipAnim(clip.id, which, { style, seconds });
      const next = useEditor.getState().clips.find((c) => c.id === clip.id)!;
      const anim = which === "in" ? next.animIn : next.animOut;
      return { id: next.id, which, style: anim?.style ?? "none", seconds: anim?.seconds ?? 0 };
    }

    case "set_look": {
      const clip = requireItem(s.clips, input.clipId, "video clip");
      if (input.style === "none") {
        s.setClipLook(clip.id, null);
        return { id: clip.id, look: "none" };
      }
      const style = LOOK_IDS.find((x) => x === input.style);
      if (!style)
        throw new ToolError(`Unknown look. Use one of: ${LOOK_IDS.join(", ")}, none.`);
      s.setClipLook(clip.id, style, isNum(input.amount) ? input.amount : undefined);
      const next = useEditor.getState().clips.find((c) => c.id === clip.id)!;
      return { id: next.id, look: next.look ?? "none", amount: next.lookAmount ?? 1 };
    }

    case "merge_cue": {
      const cue = requireItem(s.subtitles.cues, input.id, "subtitle cue");
      const mates = laneCues(s.subtitles, cue.lane ?? 0);
      if (mates.findIndex((c) => c.id === cue.id) <= 0)
        throw new ToolError("That is its track's first cue — nothing before it to merge into.");
      s.mergeCueIntoPrev(cue.id);
      return { mergedInto: "previous cue" };
    }

    case "set_aspect": {
      const a = typeof input.aspect === "string" ? normalizeAspect(input.aspect) : null;
      if (!a)
        throw new ToolError(
          'aspect must be "W:H" up to an 8:1 shape — whole or decimal sides, e.g. "9:16", "1:1", "9:2", "2.39:1".'
        );
      s.setAspect(a);
      const f = frameOf(a);
      return { aspect: a, frame: `${f.w}x${f.h}` };
    }

    case "set_project_fade": {
      if (!isNum(input.fadeIn) && !isNum(input.fadeOut))
        throw new ToolError("Pass fadeIn and/or fadeOut seconds (0 clears).");
      s.setProjectFade({
        ...(isNum(input.fadeIn) ? { fadeIn: input.fadeIn } : {}),
        ...(isNum(input.fadeOut) ? { fadeOut: input.fadeOut } : {}),
      });
      const after = useEditor.getState();
      return { fadeIn: after.fadeIn, fadeOut: after.fadeOut };
    }

    case "set_project_name": {
      if (typeof input.name !== "string" || !input.name.trim())
        throw new ToolError("name is required.");
      s.setProjectName(input.name.trim());
      return { name: input.name.trim() };
    }

    default:
      throw new ToolError(`Unknown tool: ${name}`);
  }
}

/** Synthesize speech segments with hosted Gemini voices (the user's Donkey
 * sign-in and credits), register the media, and drop one soundtrack clip
 * (voiceovers duck other audio by default). Shared by voiceover_generate and
 * read_subtitles_aloud. */
async function synthesizeVoiceover(
  segments: { text: string; at: number }[],
  name: string,
  start: number,
  input: Record<string, unknown>,
  place: boolean
) {
  const projectId = useEditor.getState().projectId;
  if (!projectId) throw new ToolError("No project open.");
  const voice = resolveVoice(typeof input.voice === "string" ? input.voice : undefined);
  const direction =
    typeof input.direction === "string" && input.direction.trim()
      ? input.direction.trim()
      : undefined;
  const duck = isNum(input.duck) ? clamp(input.duck, 0, 1) : DUCK_DEFAULT;
  // Captured before synthesis: the audio files under the chat that asked,
  // even if the user switches threads while it renders.
  const chatId = chatOwner();
  const { asset, offset } = await synthesizeSpeech(projectId, segments, {
    voice,
    direction,
    language: typeof input.language === "string" ? input.language : undefined,
    name,
  });
  const cur = useEditor.getState();
  cur.addAsset(asset);
  tagChatAsset(asset.id, chatId);
  void enrichAsset(asset);
  if (!place) {
    return {
      assetId: asset.id,
      name: asset.name,
      voice,
      duration: round2(asset.duration),
      addedToTimeline: false,
      note: "The voiceover previews in this chat — the user can play it and drag it onto the soundtrack; pass add_to_timeline or start when they ask for it in the cut.",
    };
  }
  // A single script lands at `start`; a multi-line readout is pre-offset to its
  // first cue, so it lands at that offset.
  const at = segments.length === 1 ? start : offset;
  cur.addAudioFromAsset(asset.id, at, { duck: duck < 1 ? duck : undefined });
  const sel = useEditor.getState().selection;
  return {
    assetId: asset.id,
    name: asset.name,
    audioClipId: sel?.kind === "audio" ? sel.id : null,
    voice,
    start: round2(at),
    duration: round2(asset.duration),
    duck: duck < 1 ? duck : null,
    addedToTimeline: true,
  };
}

/** Draw each cell's source-time stamp onto a contact sheet. The bundled
 * ffmpeg ships without a text renderer (LGPL build, no freetype), so the
 * stamps land here, where a canvas always can. */
async function stampSheet(
  image: string,
  times: number[],
  layout: { grid: number; margin: number; padding: number }
): Promise<string> {
  const img = new Image();
  await new Promise<void>((resolve, reject) => {
    img.onload = () => resolve();
    img.onerror = () => reject(new Error("Bad sheet image."));
    img.src = image;
  });
  const canvas = document.createElement("canvas");
  canvas.width = img.naturalWidth;
  canvas.height = img.naturalHeight;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("No 2d context.");
  ctx.drawImage(img, 0, 0);
  const { grid, margin, padding } = layout;
  const cellW = (canvas.width - 2 * margin - (grid - 1) * padding) / grid;
  const cellH = (canvas.height - 2 * margin - (grid - 1) * padding) / grid;
  const size = Math.max(13, Math.round(cellH / 12));
  ctx.font = `bold ${size}px ui-monospace, monospace`;
  ctx.textBaseline = "bottom";
  times.forEach((t, i) => {
    const x = margin + (i % grid) * (cellW + padding);
    const y = margin + Math.floor(i / grid) * (cellH + padding);
    const label = `${round2(t)}s`;
    const w = ctx.measureText(label).width;
    ctx.fillStyle = "rgba(0,0,0,0.6)";
    ctx.fillRect(x + 4, y + cellH - size - 10, w + 10, size + 8);
    ctx.fillStyle = "#fff";
    ctx.fillText(label, x + 9, y + cellH - 6);
  });
  return canvas.toDataURL("image/jpeg", 0.8);
}

/** Resolve a watch/listen target: a timeline clip (its source plus trim and
 * placement) or a bare project asset. */
function resolveWatchTarget(
  s: ReturnType<typeof useEditor.getState>,
  input: Record<string, unknown>
): {
  asset: MediaAsset;
  clip: { id: string; start: number; in: number; out: number; speed?: number } | null;
} {
  if (input.clip_id !== undefined && input.clip_id !== null) {
    const id = String(input.clip_id);
    const clip =
      s.clips.find((c) => c.id === id) ??
      s.audioClips.find((c) => c.id === id);
    if (!clip) throw new ToolError(`No clip with id ${id}. Call get_state for current ids.`);
    const asset = s.assets.find((a) => a.id === clip.assetId);
    if (!asset) throw new ToolError("That clip's media asset is missing.");
    return { asset, clip };
  }
  if (input.asset_id !== undefined && input.asset_id !== null) {
    return { asset: requireItem(s.assets, input.asset_id, "project asset"), clip: null };
  }
  throw new ToolError("Pass clip_id or asset_id — see videoTrack and media in the editor state.");
}

/** The shared preamble for the source-reading tools (watch_video, detect_silence):
 * require an open project, resolve the target asset/clip, and derive the source
 * range to scan. Each tool then does its own media-type check and API call. */
function resolveWatchRange(
  s: ReturnType<typeof useEditor.getState>,
  input: Record<string, unknown>,
): {
  projectId: string;
  asset: MediaAsset;
  clip: { id: string; start: number; in: number; out: number; speed?: number } | null;
  speed: number;
  from: number;
  to: number | undefined;
} {
  const projectId = s.projectId;
  if (!projectId) throw new ToolError("No project open.");
  const { asset, clip } = resolveWatchTarget(s, input);
  const speed = clip?.speed && clip.speed > 0 ? clip.speed : 1;
  const dur = asset.duration > 0 ? asset.duration : Infinity;
  const from = clamp(isNum(input.from) ? input.from : clip ? clip.in : 0, 0, dur);
  // An unknown duration leaves `to` for the engine to probe.
  const to = isNum(input.to)
    ? clamp(input.to, 0, dur)
    : clip
      ? clip.out
      : Number.isFinite(dur)
        ? dur
        : undefined;
  if (to !== undefined && to <= from)
    throw new ToolError("from/to describe an empty range of the source.");
  return { projectId, asset, clip, speed, from, to };
}

/** Pull a source's audio track off (video and audio alike) and inline it for
 * the model; null when the range clears the inline cap. Local: the engine
 * extracts mono AAC. Cloud: the browser renders the span to 16 kHz mono WAV. */
async function listenToSource(
  projectId: string,
  asset: MediaAsset,
  from: number,
  to: number | undefined,
): Promise<InlineImage | null> {
  if (getBackend().kind === "cloud") {
    const wav = await renderAudioSpanWav(asset.url, from, to).catch((e) => {
      throw new ToolError(e instanceof Error ? e.message : "Could not read the audio.");
    });
    return blobToInlineAudio(wav);
  }
  const res = await apiFetch(`/api/cut/projects/${projectId}/audio`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ file: asset.fileName, from, ...(to !== undefined ? { to } : {}) }),
  });
  if (!res.ok) {
    const body = await apiJson<{ error?: string }>(res).catch(() => ({ error: undefined }));
    throw new ToolError(body.error ?? "Could not read the audio.");
  }
  return blobToInlineAudio(await res.blob());
}

function requireItem<T extends { id: string }>(pool: T[], id: unknown, label: string): T {
  const item = pool.find((x) => x.id === String(id ?? ""));
  if (!item) throw new ToolError(`No ${label} with id ${String(id)}. Call get_state for current ids.`);
  return item;
}

/** Resolve a subtitle-track tool param (default: the active track), make it
 * the active track — generation, translation, and readout all write there. */
function targetSubtitleTrack(input: Record<string, unknown>): number {
  const s = useEditor.getState();
  const count = subtitleLaneCount(s.subtitles);
  const lane = isNum(input.track) ? Math.round(input.track) : s.subtitleLane;
  if (lane < 0 || lane >= count)
    throw new ToolError(
      `No subtitle track ${lane} — tracks 0–${count - 1} exist (subtitles_add_track adds one).`
    );
  s.setSubtitleLane(lane);
  return lane;
}

/** Map generation reference ids to project assets. Audio can't be looked at,
 * so only image and video assets resolve. */
function resolveRefAssets(ids: unknown): AssetRef[] {
  if (ids === undefined || ids === null) return [];
  const s = useEditor.getState();
  return (Array.isArray(ids) ? ids : [ids]).map((raw) => {
    const asset = s.assets.find((a) => a.id === String(raw));
    if (!asset)
      throw new ToolError(`No project asset with id ${String(raw)} — see media in the editor state.`);
    if (asset.type === "audio")
      throw new ToolError(`"${asset.name}" is audio — visual references must be images or videos.`);
    return refFromAsset(asset);
  });
}

/** Map music-reference ids to project asset refs. Music takes any media as a
 * style reference — an audio track to match, or video/images for tone — so
 * unlike the visual generators, audio resolves here too. */
function resolveMusicRefs(ids: unknown): AssetRef[] {
  if (ids === undefined || ids === null) return [];
  const s = useEditor.getState();
  return (Array.isArray(ids) ? ids : [ids]).map((raw) => {
    const asset = s.assets.find((a) => a.id === String(raw));
    if (!asset)
      throw new ToolError(`No project asset with id ${String(raw)} — see media in the editor state.`);
    return refFromAsset(asset);
  });
}

/** An overlay clip's frame patch for a layout preset name. */
const OVERLAY_LAYOUT_KEYS = {
  full: "full",
  top: "top",
  bottom: "bottom",
  left: "left",
  right: "right",
  pip: "corner",
} as const;

function layoutPatch(layout: string): Partial<VideoClip> {
  const key = OVERLAY_LAYOUT_KEYS[layout as keyof typeof OVERLAY_LAYOUT_KEYS];
  if (!key)
    throw new ToolError(`Unknown layout "${layout}". Use full, top, bottom, left, right, or pip.`);
  const L = LAYOUTS[key];
  return { frame: key === "full" ? undefined : { ...L.rect }, fit: L.fit };
}

/** The model asked for timeline placement — explicitly, or implicitly by
 * giving a position. Otherwise generated media stays on its chat card. */
function wantsTimeline(input: Record<string, unknown>, positionKey: "index" | "start"): boolean {
  return input.add_to_timeline === true || isNum(input[positionKey]);
}

const NOT_PLACED = { added: false, clipId: null, index: null };

/** Place a project asset on the timeline like a drag: video/image onto track 0
 * (an `index` insert, a free-positioned `start`, or appended at the end),
 * audio onto the soundtrack. Returns the created clip's summary. */
function placeAssetOnTimeline(asset: MediaAsset, input: Record<string, unknown>) {
  const s = useEditor.getState();
  const start = isNum(input.start) ? Math.max(0, input.start) : undefined;
  if (asset.type === "audio") {
    s.addAudioFromAsset(asset.id, start);
    const sel = useEditor.getState().selection;
    const c =
      sel?.kind === "audio"
        ? useEditor.getState().audioClips.find((x) => x.id === sel.id)
        : undefined;
    if (!c) throw new ToolError("Could not create the soundtrack clip.");
    return { id: c.id, kind: asset.type, start: round2(c.start), len: round2(c.out - c.in) };
  }
  let clipId: string | null;
  if (isNum(input.index)) {
    clipId = addVideoTrackClip(asset.id, Math.round(input.index)).clipId;
  } else {
    s.addClipFromAsset(asset.id, start);
    const sel = useEditor.getState().selection;
    clipId = sel?.kind === "clip" ? sel.id : null;
  }
  const c = clipId ? useEditor.getState().clips.find((x) => x.id === clipId) : undefined;
  if (!c) throw new ToolError("Could not create the clip.");
  return {
    id: c.id,
    kind: asset.type,
    index: track0Clips(useEditor.getState().clips).findIndex((x) => x.id === c.id),
    start: round2(c.start),
    len: round2(c.out - c.in),
  };
}

const promptedIndex = (input: Record<string, unknown>): number | undefined =>
  isNum(input.index) ? Math.round(input.index) : undefined;

/** Append a project asset to the video track, at `index` when given. Shared
 * by add_clip, generate_image (inline), and the video renders' completion. */
function addVideoTrackClip(
  assetId: string,
  index?: number
): { added: boolean; clipId: string | null; index: number | null } {
  const s = useEditor.getState();
  if (!s.assets.some((a) => a.id === assetId)) return NOT_PLACED;
  s.addClipFromAsset(assetId); // lands at the end, selected
  const sel = useEditor.getState().selection;
  const clipId = sel?.kind === "clip" ? sel.id : null;
  const count = useEditor.getState().clips.length;
  const at = index === undefined ? count - 1 : clamp(Math.round(index), 0, count - 1);
  if (clipId && at !== count - 1) s.moveClip(clipId, at);
  return { added: true, clipId, index: at };
}

/** Start a video render — the shared shape of generate_video and
 * generate_character_video: one job (and one chat card) spans the ladder's
 * fallback rungs, the landed asset files under the asking chat, and it goes
 * onto the timeline only when the model asked.
 *
 * Awaits the submission, not the render: it returns started:true only once the
 * backend actually accepted the render, so the model can say it is underway. An
 * instant reject — bad credentials, no credits, a bad request — settles the
 * submit in well under a second and comes back started:false with the reason,
 * so the model reports the failure instead of narrating a clip that never
 * started. `success.note` overrides the default "rendering" line; `success.extra`
 * merges caller facts (the designed still, the character) into either outcome. */
async function launchVideoJob(
  projectId: string,
  input: Record<string, unknown>,
  attempts: VideoAttempt[],
  success?: { note?: string; extra?: Record<string, unknown> }
) {
  const addToTimeline = wantsTimeline(input, "index");
  const index = promptedIndex(input);
  // Captured now: the render must file under the chat that asked, even if
  // the user switches threads before it lands. Ownership rides the job from
  // creation, so neither the job row nor the landed asset ever touches the
  // Video panel — including a render that errors and lands no asset.
  const chatId = chatOwner();
  const { jobId, submitted } = useGenerate.getState().generateVideoLadder(projectId, attempts, {
    ...(chatId ? { chatId } : {}),
    onDone: (asset) => {
      if (addToTimeline) addVideoTrackClip(asset.id, index);
    },
  });
  const extra = success?.extra ?? {};
  const outcome = await submitted;
  if (!outcome.ok) {
    return {
      kind: "video",
      started: false,
      jobId,
      ...extra,
      error: outcome.error,
      note: `The render didn't start — ${outcome.error} Tell the user it failed; don't say it's rendering.`,
    };
  }
  return {
    kind: "video",
    started: true,
    jobId,
    addToTimeline,
    ...extra,
    note:
      success?.note ??
      ("Rendering — it previews in this chat when it lands, in a minute or two" +
        (addToTimeline
          ? ", and goes onto the timeline."
          : ". It stays in the chat until the user places it.")),
  };
}

function titlePatch(input: Record<string, unknown>) {
  const patch: Record<string, unknown> = {};
  if (typeof input.text === "string" && input.text.trim()) patch.text = input.text;
  if (isNum(input.start)) patch.start = Math.max(0, input.start);
  if (isNum(input.end)) patch.end = input.end;
  if (isNum(input.x)) patch.x = clamp(input.x, 0.02, 0.98);
  if (isNum(input.y)) patch.y = clamp(input.y, 0.02, 0.98);
  if (isNum(input.size)) patch.size = clamp(Math.round(input.size), 16, 320);
  if (typeof input.color === "string") patch.color = input.color;
  if (["sf", "serif", "rounded", "mono", "impact"].includes(String(input.font)))
    patch.font = input.font as FontId;
  if (input.weight === 400 || input.weight === 700) patch.weight = input.weight;
  if (typeof input.shadow === "boolean") patch.shadow = input.shadow;
  if (typeof input.plate === "boolean") patch.plate = input.plate;
  if (isNum(input.plateRadius)) patch.plateRadius = clamp(input.plateRadius, 0, 1);
  return patch;
}
