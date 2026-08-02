/**
 * The editor bridge — the typed tool set the orchestrator drives the timeline
 * through. Nothing else touches the editor.
 *
 * Frames, not seconds, cross this boundary: the orchestrator plans in frames
 * and this interface is where the conversion to the editor's seconds happens,
 * once, using the timeline fps. The real bridge (wired later) forwards to Cut's
 * editor store; the fake bridge records placements in memory so a test can
 * assert the track is fully covered and correctly timed.
 */

export interface TimelineInfo {
  fps: number;
  durationFrames: number;
  aspect: "9:16" | "16:9";
}

export interface AudioClipInfo {
  clipId: string;
  assetId: string;
  startFrame: number;
  durationFrames: number;
}

export interface EditorBridge {
  getTimeline(): TimelineInfo;
  getAudioClips(): AudioClipInfo[];
  /** Bring a generated media asset into the project pool; returns its media id. */
  importMedia(mediaId: string): Promise<string>;
  /**
   * Place a video clip on the video track filling a [startFrame, endFrame)-
   * sized slot. Where it lands is the editor's call: the planned frames are the
   * target, and the anchors keep a moving timeline honest — the clip lands
   * after the furthest of `anchorAfterIds` (clips the run's earlier shots still
   * hold), never slides past any of `followClipIds` (clips its later shots
   * hold; those push right instead), and clears whatever else occupies the row.
   * `srcInSec` starts the clip's source window there (the reviewer's chosen
   * moment) instead of at 0. `muted` silences the clip's own audio — set for a
   * provided-audio scene's b-roll, cleared for a generated scene whose shot
   * carries its own burned-in narration (defaults to muted).
   * Returns the new timeline clip id.
   */
  placeClip(
    mediaId: string,
    startFrame: number,
    endFrame: number,
    opts?: { srcInSec?: number; muted?: boolean; anchorAfterIds?: string[]; followClipIds?: string[] }
  ): Promise<string>;
  /** Swap the media under an existing clip (regeneration), keeping its slot. */
  replaceClipMedia(clipId: string, mediaId: string): Promise<void>;
  /** Retime a clip so its footprint is exactly `durationFrames`. */
  retimeClip(clipId: string, durationFrames: number): Promise<void>;
  /** Remove a clip, leaving its slot empty. */
  removeClip(clipId: string): Promise<void>;
  /** Add a transition from a clip into the next, in frames. */
  addTransition(clipId: string, style: string, durationFrames: number): Promise<void>;
  /** Place audio (voiceover or a music bed) on the soundtrack. `volume` sets its
   * baseline gain — a music bed sits under the shots' burned-in narration. */
  placeAudio(
    mediaId: string,
    startFrame: number,
    durationFrames: number,
    opts?: { kind?: "voice" | "music"; duck?: number; lane?: number; volume?: number }
  ): Promise<string>;
  /** Remove a soundtrack clip, so voice/music placement stays idempotent. */
  removeAudio(clipId: string): Promise<void>;
}

export interface PlacedAudio {
  clipId: string;
  mediaId: string;
  startFrame: number;
  durationFrames: number;
  kind: "voice" | "music";
  volume?: number;
}

/** What the fake editor recorded for one placed clip. */
export interface PlacedClip {
  clipId: string;
  mediaId: string;
  startFrame: number;
  endFrame: number;
  srcInSec?: number;
  muted?: boolean;
  transition?: { style: string; durationFrames: number };
}

/** In-memory editor that records placements instead of touching a real store. */
export class FakeEditor implements EditorBridge {
  readonly placed: PlacedClip[] = [];
  readonly placedAudio: PlacedAudio[] = [];
  private seq = 0;

  constructor(private readonly timeline: TimelineInfo, private readonly audio: AudioClipInfo[]) {}

  getTimeline(): TimelineInfo {
    return this.timeline;
  }

  getAudioClips(): AudioClipInfo[] {
    return this.audio;
  }

  async importMedia(mediaId: string): Promise<string> {
    return mediaId;
  }

  async placeClip(
    mediaId: string,
    startFrame: number,
    endFrame: number,
    opts?: { srcInSec?: number; muted?: boolean; anchorAfterIds?: string[]; followClipIds?: string[] }
  ): Promise<string> {
    const clipId = `clip:${this.seq++}`;
    this.placed.push({
      clipId,
      mediaId,
      startFrame,
      endFrame,
      ...(opts?.srcInSec ? { srcInSec: opts.srcInSec } : {}),
      muted: opts?.muted ?? true,
    });
    return clipId;
  }

  async replaceClipMedia(clipId: string, mediaId: string): Promise<void> {
    const clip = this.require(clipId);
    clip.mediaId = mediaId;
  }

  async retimeClip(clipId: string, durationFrames: number): Promise<void> {
    const clip = this.require(clipId);
    clip.endFrame = clip.startFrame + durationFrames;
  }

  async removeClip(clipId: string): Promise<void> {
    const i = this.placed.findIndex((c) => c.clipId === clipId);
    if (i >= 0) this.placed.splice(i, 1);
  }

  async addTransition(clipId: string, style: string, durationFrames: number): Promise<void> {
    this.require(clipId).transition = { style, durationFrames };
  }

  async placeAudio(
    mediaId: string,
    startFrame: number,
    durationFrames: number,
    opts?: { kind?: "voice" | "music"; duck?: number; lane?: number; volume?: number }
  ): Promise<string> {
    const clipId = `audio:${this.seq++}`;
    this.placedAudio.push({
      clipId,
      mediaId,
      startFrame,
      durationFrames,
      kind: opts?.kind ?? "voice",
      ...(opts?.volume !== undefined ? { volume: opts.volume } : {}),
    });
    return clipId;
  }

  async removeAudio(clipId: string): Promise<void> {
    const i = this.placedAudio.findIndex((c) => c.clipId === clipId);
    if (i >= 0) this.placedAudio.splice(i, 1);
  }

  /** The placed clips sorted by start — the timeline as the fake sees it. */
  timeline_clips(): PlacedClip[] {
    return [...this.placed].sort((a, b) => a.startFrame - b.startFrame);
  }

  private require(clipId: string): PlacedClip {
    const clip = this.placed.find((c) => c.clipId === clipId);
    if (!clip) throw new Error(`no clip ${clipId}`);
    return clip;
  }
}
