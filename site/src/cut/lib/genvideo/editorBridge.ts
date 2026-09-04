"use client";

import { retimeOf, type SpeedNode } from "@donkeycut/effects-kit";

/**
 * The real EditorBridge: the orchestrator's typed hands on the live Cut
 * timeline. It is the single frames↔seconds conversion boundary — the plan
 * reasons in whole frames at a fixed project rate, the editor store speaks
 * seconds, and every method here divides or multiplies by GEN_FPS exactly once.
 *
 * Placement forwards to the store's id-returning gen actions (placeGenClip /
 * placeGenAudio / removeClipById / removeAudioById), which land through the
 * store's run placement primitive — anchored to the run's own clips, slid
 * clear of everything else — and never touch the user's selection, so a run
 * populates the track in the background while the user keeps editing. A
 * provided-audio scene mutes its b-roll under the user's spine; a generated
 * scene leaves the shot's burned-in narration audible. `importMedia` is
 * identity: the media adapters already import their output into the project, so
 * what they return is a real asset id.
 *
 * Every mutation is scoped to the run's own project: the store holds one open
 * project at a time, and a background run whose project the user has since
 * switched away from must never write to whatever project is now on screen. So
 * each method checks the open project first and no-ops (or throws, for the
 * id-returning placements) when it isn't this run's.
 */

import { useEditor } from "../store";
import { nearestAspect, TRANSITION_STYLE_IDS, type TransitionStyle } from "../types";
import { defaultVideoAspects } from "../videoModels";
import { docPlaceGenAudio, docPlaceGenClip, projectWriteMode, withProjectDoc } from "./docWriter";
import type { AudioClipInfo, EditorBridge, TimelineInfo } from "./editor";

/** The rate the plan runs at. Fixed to the export frame rate so a shot's frame
 * math lines up with the rendered file. */
export const GEN_FPS = 30;

const toSec = (frames: number) => frames / GEN_FPS;

/** Effective timeline footprint of a clip (seconds), through its rate. */
function footprintSec(c: { in: number; out: number; speed?: number; speedCurve?: SpeedNode[]; reverse?: boolean }): number {
  return retimeOf(c).len;
}

export class StoreEditorBridge implements EditorBridge {
  /** The last timeline shape read while the project was open — the sync reads
   * fall back to it when the project is closed (a background run only needs
   * the aspect, and the plan froze its own at approval). */
  private lastTimeline: TimelineInfo | null = null;

  constructor(private readonly projectId: string) {}

  /** Whether this run's project is the one currently open in the store. */
  private open(): boolean {
    const s = useEditor.getState();
    return s.projectId === this.projectId && s.loaded;
  }

  /** Where this call must write: the live store when the run's project is
   * open, its persisted doc when the user has moved on (see projectWriteMode
   * for the load-race and failed-load rules). */
  private mode(): Promise<"store" | "doc"> {
    return projectWriteMode(this.projectId);
  }

  getTimeline(): TimelineInfo {
    if (!this.open()) {
      return this.lastTimeline ?? { fps: GEN_FPS, durationFrames: 0, aspect: "9:16" };
    }
    const s = useEditor.getState();
    const clipEnd = Math.max(
      0,
      ...s.clips.map((c) => c.start + footprintSec(c)),
      ...s.audioClips.map((c) => c.start + footprintSec(c))
    );
    this.lastTimeline = {
      fps: GEN_FPS,
      durationFrames: Math.round(clipEnd * GEN_FPS),
      // The pipeline renders in the shapes the models support; a custom
      // project ratio maps to the closest one and letterboxes on the timeline.
      aspect: nearestAspect(s.aspect, defaultVideoAspects()),
    };
    return this.lastTimeline;
  }

  getAudioClips(): AudioClipInfo[] {
    if (!this.open()) return [];
    return useEditor.getState().audioClips.map((c) => ({
      clipId: c.id,
      assetId: c.assetId,
      startFrame: Math.round(c.start * GEN_FPS),
      durationFrames: Math.round(footprintSec(c) * GEN_FPS),
    }));
  }

  async importMedia(mediaId: string): Promise<string> {
    // The media adapters import their output before returning, so the id is
    // already a project asset id — nothing to do.
    return mediaId;
  }

  async placeClip(
    mediaId: string,
    startFrame: number,
    endFrame: number,
    opts?: { srcInSec?: number; muted?: boolean; anchorAfterIds?: string[]; followClipIds?: string[] }
  ): Promise<string> {
    if ((await this.mode()) === "store") {
      const id = useEditor.getState().placeGenClip(mediaId, toSec(startFrame), toSec(endFrame), opts);
      if (!id) throw new Error(`placeClip: no placeable asset ${mediaId}`);
      return id;
    }
    let placed: string | null = null;
    await withProjectDoc(this.projectId, (doc) => {
      placed = docPlaceGenClip(doc, mediaId, toSec(startFrame), toSec(endFrame), opts);
    });
    if (!placed) throw new Error(`placeClip: no placeable asset ${mediaId}`);
    return placed;
  }

  async replaceClipMedia(clipId: string, mediaId: string): Promise<void> {
    if ((await this.mode()) === "store") {
      useEditor.getState().updateClip(clipId, { assetId: mediaId });
      return;
    }
    await withProjectDoc(this.projectId, (doc) => {
      doc.clips = doc.clips.map((c) => (c.id === clipId ? { ...c, assetId: mediaId } : c));
    });
  }

  async retimeClip(clipId: string, durationFrames: number): Promise<void> {
    if ((await this.mode()) === "store") {
      const clip = useEditor.getState().clips.find((c) => c.id === clipId);
      if (!clip) return;
      // Trim the tail so the footprint matches, at whatever rate the clip carries.
      useEditor.getState().setClipTrim(clipId, clip.in, retimeOf(clip).srcAt(toSec(durationFrames)));
      return;
    }
    await withProjectDoc(this.projectId, (doc) => {
      doc.clips = doc.clips.map((c) => {
        if (c.id !== clipId) return c;
        return { ...c, out: retimeOf(c).srcAt(toSec(durationFrames)) };
      });
    });
  }

  async removeClip(clipId: string): Promise<void> {
    if ((await this.mode()) === "store") {
      useEditor.getState().removeClipById(clipId);
      return;
    }
    await withProjectDoc(this.projectId, (doc) => {
      doc.clips = doc.clips.filter((c) => c.id !== clipId);
    });
  }

  async addTransition(clipId: string, style: string, durationFrames: number): Promise<void> {
    const safeStyle: TransitionStyle = TRANSITION_STYLE_IDS.includes(style as TransitionStyle)
      ? (style as TransitionStyle)
      : "crossfade";
    if ((await this.mode()) === "store") {
      useEditor.getState().setClipTransition(clipId, toSec(durationFrames), safeStyle);
      return;
    }
    await withProjectDoc(this.projectId, (doc) => {
      doc.clips = doc.clips.map((c) =>
        c.id === clipId ? { ...c, transition: toSec(durationFrames), transitionStyle: safeStyle } : c
      );
    });
  }

  async placeAudio(
    mediaId: string,
    startFrame: number,
    durationFrames: number,
    opts?: { kind?: "voice" | "music"; duck?: number; lane?: number; volume?: number }
  ): Promise<string> {
    const audioOpts = {
      ...(opts?.duck !== undefined ? { duck: opts.duck } : {}),
      ...(opts?.lane !== undefined ? { lane: opts.lane } : {}),
      ...(opts?.volume !== undefined ? { volume: opts.volume } : {}),
    };
    if ((await this.mode()) === "store") {
      const id = useEditor
        .getState()
        .placeGenAudio(mediaId, toSec(startFrame), toSec(durationFrames), audioOpts);
      if (!id) throw new Error(`placeAudio: no audio asset ${mediaId}`);
      return id;
    }
    let placed: string | null = null;
    await withProjectDoc(this.projectId, (doc) => {
      placed = docPlaceGenAudio(doc, mediaId, toSec(startFrame), toSec(durationFrames), audioOpts);
    });
    if (!placed) throw new Error(`placeAudio: no audio asset ${mediaId}`);
    return placed;
  }

  async removeAudio(clipId: string): Promise<void> {
    if ((await this.mode()) === "store") {
      useEditor.getState().removeAudioById(clipId);
      return;
    }
    await withProjectDoc(this.projectId, (doc) => {
      doc.audioClips = doc.audioClips.filter((c) => c.id !== clipId);
    });
  }
}
