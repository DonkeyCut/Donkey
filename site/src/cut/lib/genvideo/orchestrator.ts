/**
 * The brief-to-video orchestrator: a state machine, not a free-form loop.
 *
 * Phases run in order and the run is re-entrant — `run()` advances from
 * whatever phase the persisted project is in, so a restart resumes and a
 * follow-up turn re-enters for a subset of shots. The model is called only at
 * the genuine judgment points (script, breakdown, style); every other step is
 * deterministic. After every shot-list mutation the coverage invariant is
 * re-asserted, and the worker pool fills the track incrementally so the user
 * watches it populate.
 *
 *   brief → ingest → breakdown → (confirm) → style → keyframes → generating → polish → done
 *
 * The keyframes phase closes with a storyboard read: the minted frames are
 * judged as one ordered sequence and any that fail to carry the story forward
 * are reworked before generation, so drift is caught while it is still cheap.
 *
 * A run has one audio spine. In provided mode it is the user's dropped-in
 * audio: shots tile it, their own audio muted, each lip-synced to its slice
 * (inline for an audio-native model, else a lip-sync pass). In generated mode
 * the shots ARE the spine — the video model burns each shot's slice of the
 * scripted narration into the clip, so the clip plays unmuted and no separate
 * voice track is placed; a music bed sits under it. Every placement is
 * idempotent (a resume or a regeneration swaps a clip in only once the
 * replacement is ready), so no path double-stacks video or music, and none
 * leaves a hole in the track.
 */

import { assertCoverage, frameToSec, MAX_SHOT_SEC, MIN_SHOT_SEC, repairCoverage, secToFrame, shotDurationFrames, sliceWords } from "./coverage";
import { fanOut } from "./pool";
import { buildNegative, buildPrompt, buildRefPrompt, refsForAsset, shotRefs, styleAnchor } from "./prompt";
import { segmentByDuration, type ModelSuite, type ReviewVerdict } from "./capabilities";
import type { EditorBridge } from "./editor";
import type { BeatVoice, RefAsset, ScriptBeat, Shot, TranscriptWord, VideoAsset, VideoEmit, VideoPhase, VideoProject } from "./types";

export interface OrchestratorDeps {
  editor: EditorBridge;
  suite: ModelSuite;
  emit: VideoEmit;
  /** Write the plan to disk (rides ProjectDoc.genvideo). */
  persist: (project: VideoProject) => void | Promise<void>;
  /** Workers in flight during generation (tuned to the provider's rate limit). */
  concurrency?: number;
  /** Injected sleep so tests run instantly. */
  sleep?: (ms: number) => Promise<void>;
}

// Takes per shot before the on-model still holds the slot. Generous on
// purpose: a person-policy block on the seed is per-image luck, so every
// retake re-rolls it with a fresh keyframe, and the director throws away
// off-model takes — attempts are the shot's supply of dice.
export const VIDEO_ATTEMPTS = 5;
const REF_ATTEMPTS = 2; // extra retries for continuity anchors
const BACKOFF_MS = 500;
// The music bed's baseline gain — it underscores the shots' burned-in
// narration rather than competing with it (a generated scene has no separate
// voice track to duck the music beneath).
const MUSIC_BED_VOLUME = 0.4;

export class VideoOrchestrator {
  /** Serializes persistence so concurrent shot updates never interleave writes. */
  private saveChain: Promise<void> = Promise.resolve();
  /** Set when a newer run supersedes this one (the user switched projects), so
   * in-flight work stops writing to the timeline or the persisted plan. */
  private aborted = false;

  constructor(public project: VideoProject, private readonly deps: OrchestratorDeps) {}

  /** Abandon this run: later phases and the persist chain become no-ops. Called
   * before a replacement orchestrator takes over, and when the run's project
   * stops being open, so nothing renders (or spends) against a project the
   * user has left. The persisted plan resumes via hydrate. */
  abort(): void {
    this.aborted = true;
  }

  /** Whether this run was superseded or paused — late settlements check this so
   * they never touch state a newer run now owns. */
  get isAborted(): boolean {
    return this.aborted;
  }

  /** The shape every keyframe and shot renders at. Frozen on the plan (captured
   * at start, refreshed at approval — the last moment the user can set it), so
   * a background render can never pick up another open project's shape. The
   * live read only backfills a plan persisted before the field existed. */
  private get aspect(): "9:16" | "16:9" {
    return this.project.aspect ?? this.deps.editor.getTimeline().aspect;
  }

  private get fps(): number {
    return this.project.fps;
  }
  private get durationFrames(): number {
    return this.project.durationFrames;
  }

  /** Advance the run from its current phase to the next stopping point. An
   * abort landing between phases stops the walk — no later phase may render or
   * spend once the run is superseded or paused. */
  async run(): Promise<VideoProject> {
    if (this.project.phase === "failed" || this.project.phase === "done") return this.project;
    return this.failLoudly(async () => {
      // Plan all the way to the storyboard: script/segment the shots, design the
      // look and cast, draw every opening frame, then read the frames as one
      // sequence and rework the ones that don't carry the story. The sheets and
      // keyframes are cheap images; the expensive video is what waits behind the
      // gate. Skipped once already past the gate (an approve or a resume of an
      // approved run re-enters here).
      if (!this.project.breakdownApproved && this.project.phase !== "storyboard") {
        const plan = [this.brief, this.ingest, this.breakdown, this.style, this.keyframes];
        for (const phase of plan) {
          if (this.aborted) return this.project;
          await phase.call(this);
        }
        if (this.aborted) return this.project;
        // Park at the storyboard gate for the user to approve or edit the frames.
        if (!this.project.breakdownApproved) {
          this.setPhase("storyboard");
          await this.save();
          return this.project;
        }
      }
      if (!this.project.breakdownApproved) return this.project; // still parked at the gate
      // Past the gate: the approved storyboard renders. Generated mode voices
      // nothing — each shot's video carries its own narration — so the only
      // spend beyond here is the takes and the music bed.
      const paid = [this.generateAndPlaceAll, this.polish];
      for (const phase of paid) {
        if (this.aborted) return this.project;
        await phase.call(this);
      }
      return this.project;
    });
  }

  /** Run a lifecycle step; a throw becomes the run's persisted terminal
   * outcome. Without this the plan keeps its mid-render phase on disk, and the
   * next load silently resumes (and re-bills) a run the user watched die. An
   * aborted run is an interruption, not an outcome — it persists nothing. */
  private async failLoudly<T>(work: () => Promise<T>): Promise<T> {
    try {
      return await work();
    } catch (e) {
      if (!this.aborted) {
        this.setPhase("failed");
        await this.save().catch(() => {});
      }
      throw e;
    }
  }

  /** An explicit user retry of a failed run. Auto-resume paths skip a failed
   * plan (that stop is what failLoudly buys); the click re-arms it, and every
   * phase then skips whatever already landed — voiced beats, minted sheets,
   * placed shots — so only the missing work re-bills. */
  async retryFailed(): Promise<VideoProject> {
    if (this.project.phase !== "failed") return this.project;
    // An approved run failed in generation — pick back up there; an unapproved
    // one failed in planning, so re-plan to the storyboard gate.
    this.setPhase(this.project.breakdownApproved ? "generating" : "brief");
    await this.save();
    return this.run();
  }

  /** The user approved the storyboard — the shots render from here. */
  async approveBreakdown(): Promise<VideoProject> {
    this.project.breakdownApproved = true;
    // The approval gate is the last moment the user can set the project shape;
    // freeze it now so every render matches, even after a project switch.
    this.project.aspect = this.deps.editor.getTimeline().aspect;
    await this.save();
    return this.run();
  }

  // ── Phase 0: brief → script → estimated shot plan (generated mode) ────────
  private async brief(): Promise<void> {
    if (this.project.audioMode !== "generated") return;
    if (this.project.shots.length > 0) return; // already planned (resume)
    this.setPhase("brief");
    if (!this.project.script) {
      this.project.script = await this.deps.suite.script.write({
        brief: this.project.brief,
        refs: this.project.references,
        targetSeconds: this.project.targetSeconds,
      });
      await this.save();
    }
    // Lay the plan out on estimated beat lengths (from word count). No voiceover
    // is synthesized — the video model burns each shot's line into the clip at
    // render time — so the plan the user approves is exactly what renders; the
    // music bed is deferred to polish.
    this.layoutBeats();
    await this.save();
  }

  /** Lay the shots and the beat→frame map out from the script, on estimated
   * beat lengths. A beat longer than one clip splits into contiguous sub-shots,
   * and the beat's line is sliced across them (in word order) so each sub-clip
   * speaks only its own portion — the video model burns that slice in, so a
   * split beat never repeats or truncates the narration. `beatVoices` keeps the
   * per-beat frame spans a re-cut reads; no voice asset rides it. */
  private layoutBeats(): void {
    if (!this.project.script) return;
    const minF = Math.round(MIN_SHOT_SEC * this.fps);
    const maxF = Math.round(MAX_SHOT_SEC * this.fps);
    let cursor = 0;
    const shots: Shot[] = [];
    const beatVoices: BeatVoice[] = [];
    this.project.script.beats.forEach((beat) => {
      const dur = Math.max(minF, secToFrame(estimateBeatSeconds(beat), this.fps));
      const beatStart = cursor;
      beatVoices.push({ startFrame: beatStart, durationFrames: dur });
      const pieces = splitBeat(beatStart, dur, maxF);
      const lines = sliceWords(beat.dialogue, pieces.length);
      pieces.forEach(([s, e], pi) => {
        shots.push({
          id: `shot:${shots.length}`,
          startFrame: s,
          endFrame: e,
          audioText: lines[pi] ?? "",
          dialogue: lines[pi] ?? "",
          action: beat.action,
          ...(beat.intent ? { intent: beat.intent } : {}),
          characters: beat.characters,
          location: beat.location,
          framing: beat.framing,
          status: "pending",
          attempts: 0,
        });
      });
      cursor += dur;
    });
    this.project.durationFrames = cursor;
    this.project.shots = shots;
    this.project.beatVoices = beatVoices;
    assertCoverage(this.project.shots, this.durationFrames);
  }

  // ── Phase A: ingest (provided mode) ──────────────────────────────────────
  private async ingest(): Promise<void> {
    if (this.project.audioMode !== "provided") return;
    if (this.project.transcript.length > 0 || !this.project.audioAssetId) return;
    this.setPhase("ingest");
    this.project.transcript = await this.deps.suite.transcribe.transcribe(this.project.audioAssetId);
    await this.save();
  }

  // ── Phase B: shot breakdown (provided mode) + confirmation gate ───────────
  private async breakdown(): Promise<void> {
    if (this.project.shots.length === 0) {
      this.setPhase("breakdown");
      const input = {
        transcript: this.project.transcript,
        ...(this.project.brief ? { brief: this.project.brief } : {}),
        durationFrames: this.durationFrames,
        fps: this.fps,
      };
      const id = (i: number) => `shot:${i}`;
      let shots: Shot[];
      try {
        shots = repairCoverage(await this.deps.suite.breakdown.segment(input), this.durationFrames, this.fps, id);
      } catch {
        shots = repairCoverage(segmentByDuration(input, MAX_SHOT_SEC), this.durationFrames, this.fps, id);
      }
      this.project.shots = shots;
      assertCoverage(this.project.shots, this.durationFrames);
      await this.save();
    }
    this.deps.emit({ type: "breakdown", shots: this.project.shots });
  }

  // ── Phase C: style bible + reference images ──────────────────────────────
  private async style(): Promise<void> {
    this.setPhase("style");
    if (!this.project.style || this.project.characters.length === 0) {
      // The bible is the run's spine: the look every shot leads with, the
      // negative, and the cast the sheets are minted from. A failed design
      // fails the run loudly here — before any shot spends — and a resume
      // re-runs it. A stand-in bible would silently corrupt every render.
      const bible = await this.deps.suite.style.design({
        brief: this.project.brief,
        style: this.project.style || undefined,
        refs: this.project.references,
        beats: this.project.shots.map((s) => ({
          dialogue: s.dialogue ?? s.audioText,
          action: s.action,
          characters: s.characters,
          location: s.location,
        })),
      });
      this.project.style = bible.style;
      this.project.negative = bible.negative;
      this.project.characters = bible.characters;
      this.project.locations = bible.locations;
      await this.save();
    }
    const needed = this.referencedAssets().filter((a) => !a.mediaId);
    if (needed.length > 0) {
      // The anchor sheet mints alone; the rest fan out with it riding as a
      // style reference (mintSheet), so one drawing technique propagates
      // through the whole bible instead of each sheet converging on its own.
      const queue = [...needed];
      if (!styleAnchor(this.project)) {
        await fanOut([queue.shift()!], (asset) => this.mintSheet(asset), this.poolOpts(REF_ATTEMPTS));
        await this.save();
      }
      await fanOut(queue, (asset) => this.mintSheet(asset), this.poolOpts(REF_ATTEMPTS));
      const missing = needed.filter((a) => !a.mediaId);
      if (missing.length)
        this.deps.emit({ type: "log", message: `Couldn't design ${missing.map((a) => a.name).join(", ")} — those shots may drift.` });
      await this.save();
    }
  }

  /** Render one character/location reference sheet, the run's technique
   * anchor riding along when one exists. */
  private async mintSheet(asset: VideoAsset): Promise<void> {
    if (this.aborted) return; // a paused run spends nothing more
    this.deps.emit({ type: "activity", message: `Designing ${asset.name}…`, key: asset.id });
    const anchor = styleAnchor(this.project);
    // screenedImage holds every later sheet to the anchor (the first sheet IS
    // the anchor — with none minted yet the gate skips itself).
    asset.mediaId = await this.screenedImage(
      `${buildRefPrompt(asset, this.project.style)} Avoid: ${buildNegative(this.project)}.`,
      [...refsForAsset(asset, this.project), ...(anchor ? [anchor] : [])],
      `a reference sheet of ${asset.name} — ${asset.description}`
    );
    this.deps.emit({ type: "asset", label: `Designed ${asset.name}`, mediaId: asset.mediaId, key: asset.id });
  }

  // ── Phase D: keyframes (cheap, parallel) + storyboard coherence pass ─────
  private async keyframes(): Promise<void> {
    this.setPhase("keyframes");
    const need = this.project.shots.filter((s) => !s.startKeyframe && s.status !== "placed");
    if (need.length === 0) return;
    // Failures are fine here — a shot with no keyframe still gets a still sourced
    // in placeFallback, so nothing swallowed leaves a hole.
    await fanOut(need, (shot) => this.makeKeyframes(shot), this.poolOpts(1));
    await this.save();
    // The frames are a storyboard now: read them as one sequence and rework the
    // ones that don't carry the story, BEFORE any of them seeds a paid render.
    await this.reviewStoryboard();
  }

  /** Read the minted keyframes as an ordered storyboard and re-mint every frame
   * that fails to carry the story forward — a wrong beat, a repeat, a dropped
   * prop, a teleported setting — each with the reviewer's note. Best-effort and
   * story-only (the same-artist gate already held every frame to the look): a
   * reviewer outage, or a plan with only one frame, leaves the board as drawn.
   * Runs once per keyframe pass, before generation, so the fix is cheap. */
  private async reviewStoryboard(): Promise<void> {
    if (this.aborted) return;
    const storyboard = this.deps.suite.review?.storyboard;
    if (!storyboard) return;
    const board = this.project.shots.filter((s) => s.startKeyframe && s.status !== "placed");
    if (board.length < 2) return;
    let verdict;
    try {
      verdict = await storyboard({
        logline: this.project.script?.logline?.trim() || this.project.brief,
        style: this.project.style,
        panels: board.map((s) => ({
          shotId: s.id,
          frameMediaId: s.startKeyframe,
          action: s.action,
          narration: (s.dialogue ?? s.audioText).trim(),
          ...(s.intent ? { intent: s.intent } : {}),
        })),
      });
    } catch {
      return; // the board goes to camera unread — a gate, not a blocker
    }
    const flagged = verdict.notes.filter((n) => !n.ok && n.note);
    if (flagged.length === 0) return;
    this.deps.emit({
      type: "log",
      message: `Reworking ${flagged.length} storyboard frame${flagged.length > 1 ? "s" : ""} to carry the story.`,
    });
    await fanOut(
      flagged,
      async (note) => {
        const shot = this.project.shots.find((s) => s.id === note.shotId);
        if (!shot || this.aborted) return;
        // Release the flagged frame only once its replacement exists — a failed
        // re-mint restores it rather than leaving the shot frame-less.
        const prior = shot.startKeyframe;
        shot.startKeyframe = undefined;
        try {
          await this.makeKeyframes(shot, note.note);
        } catch {
          /* restored below */
        }
        shot.startKeyframe = shot.startKeyframe ?? prior;
      },
      this.poolOpts(0)
    );
    await this.save();
  }

  private async makeKeyframes(shot: Shot, note?: string): Promise<void> {
    if (this.aborted) return; // a paused run spends nothing more
    this.updateShot(shot, { status: "keyframing" });
    const refs = shotRefs(shot, this.project);
    // The image model has no negative-prompt parameter, so the bans ride as
    // avoid-text — a letterboxed or off-medium keyframe seeds a bad video.
    const prompt = `${buildPrompt(shot, this.project)} Avoid: ${buildNegative(this.project)}.${
      note ? ` Note from the review: ${note}` : ""
    }`;
    shot.startKeyframe = await this.screenedImage(`${prompt} Opening frame.`, refs, shot.action);
    this.updateShot(shot, { status: "pending" });
  }

  // ── Phase E + F: generation fans out; each clip places when it lands ──────
  private async generateAndPlaceAll(): Promise<void> {
    if (this.aborted) return;
    this.setPhase("generating");
    const pending = this.project.shots.filter((s) => s.status !== "placed");
    await fanOut(pending, (shot) => this.generateAndPlace(shot), this.poolOpts(0));
    this.emitProgress();
  }

  private async generateAndPlace(shot: Shot): Promise<void> {
    if (this.aborted) return;
    const audio = this.audioForShot(shot);
    const basePrompt = buildPrompt(shot, this.project);
    const refs = shotRefs(shot, this.project);
    // The reviewer's note from a declined take — the retake prompt carries it.
    let critique: string | undefined;
    // Whether the next attempt should replace the seed keyframe (set by a
    // decline whose flaw traces to the seed; identity breaks keep it).
    let remintSeed = false;
    // Off-model takes that never rode an anchor: the provider is refusing
    // this shot's seed frames outright, take after take. Past two of those,
    // fresh dice aren't enough — the seed itself needs restaging (subject at
    // a distance, face away from camera) so the anchor stops being refused.
    let unanchoredMisses = 0;
    for (let attempt = 1; attempt <= VIDEO_ATTEMPTS; attempt++) {
      if (this.aborted) return; // a paused run spends nothing more
      shot.attempts = attempt;
      // Set per attempt, not once: a declined review leaves the shot in
      // "reviewing", and the retake that follows must show as rendering (this
      // is also what fires the "retake N…" ticker line).
      this.updateShot(shot, { status: "generating", error: undefined });
      const prompt = critique ? `${basePrompt} Note from the last take's review: ${critique}` : basePrompt;
      const video = this.deps.suite.video;
      try {
        // A seed-flaw decline re-mints the keyframes with the critique so the
        // retake animates a fresh frame instead of the flawed one — but the
        // prior seed is released only once its replacement exists: a failed
        // mint restores it rather than rendering anchor-less, which is how a
        // cast shot loses its character to a weaker rung.
        if (remintSeed || !shot.startKeyframe) {
          const prior = { start: shot.startKeyframe };
          shot.startKeyframe = undefined;
          remintSeed = false;
          const seedNote =
            unanchoredMisses >= 2
              ? `${critique ? `${critique} ` : ""}Restage the composition: the subject at mid-distance or seen from a three-quarter or back angle, no face near the camera, with the action still fully readable.`
              : critique;
          try {
            await this.makeKeyframes(shot, seedNote);
          } catch {
            // Restored below — a prior on-model seed beats no seed at all.
          }
          shot.startKeyframe = shot.startKeyframe ?? prior.start;
          await this.save();
          this.updateShot(shot, { status: "generating", error: undefined });
        }
        const take = await video.generate({
          prompt,
          negativePrompt: buildNegative(this.project),
          refs,
          shotId: shot.id,
          startKeyframe: shot.startKeyframe,
          durationSec: frameToSec(shotDurationFrames(shot), this.fps),
          aspect: this.aspect,
          ...(audio && video.audioNative
            ? { audioMediaId: audio.mediaId, audioFromSec: audio.fromSec, audioToSec: audio.toSec }
            : {}),
        });
        let clip = await this.deps.editor.importMedia(take.mediaId);
        // Lip-sync post-pass when the video model can't do it inline.
        if (audio && !video.audioNative && this.deps.suite.lipSync) {
          this.updateShot(shot, { status: "lipsync" });
          const synced = await this.deps.suite.lipSync.sync({
            videoMediaId: clip,
            audioMediaId: audio.mediaId,
            fromSec: audio.fromSec,
            toSec: audio.toSec,
          });
          clip = await this.deps.editor.importMedia(synced);
          shot.lipSynced = true;
        }
        // The dailies check: a reviewer watches the take against the plan.
        // A declined take retries (the throw lands in the catch below, and the
        // retake prompt carries the note). On the last attempt a weak take
        // still places — motion beats a frozen still — EXCEPT an identity
        // break: a moving stranger never lands, the shot falls out of the
        // loop and holds its on-model keyframe still instead. The chosen
        // window trims the placement to the take's best moment.
        let srcInSec: number | undefined;
        if (this.deps.suite.review) {
          this.updateShot(shot, { status: "reviewing" });
          const verdict = await this.reviewTake(clip, shot);
          if (!verdict.ok && (attempt < VIDEO_ATTEMPTS || verdict.offModel)) {
            critique = verdict.note?.trim() || "the take did not show the planned action";
            // Where the retake's seed comes from depends on where the flaw
            // came from. An identity break on an ANCHORED take keeps the
            // seed: the on-model keyframe rode the render and the model still
            // drifted — re-animating it is the fix. An identity break on an
            // UNANCHORED take means the provider refused the seed and words
            // alone drew a stranger — the seed is what's blocked, so a fresh
            // one re-rolls that refusal. Every other flaw usually traces to
            // the seed (sideways composition, wrong technique, baked text),
            // so those re-mint too, with the critique.
            remintSeed = !verdict.offModel || !take.anchored;
            if (verdict.offModel && !take.anchored) unanchoredMisses++;
            throw new Error(`Retake: ${critique}`);
          }
          srcInSec = verdict.fromSec;
        }
        // Swap the new clip in only now that it's ready, replacing any prior
        // placement (a resume's fallback still, a regen's old clip) atomically.
        await this.clearVideoPlacement(shot);
        shot.lastPrompt = prompt;
        shot.clip = clip;
        shot.timelineClipId = await this.deps.editor.placeClip(clip, shot.startFrame, shot.endFrame, {
          ...(srcInSec ? { srcInSec } : {}),
          // Generated mode: the clip carries its own burned-in narration, so it
          // plays. Provided mode: mute the b-roll under the user's audio spine.
          muted: this.project.audioMode === "provided",
          ...this.placementAnchors(shot),
        });
        this.updateShot(shot, { status: "placed", error: undefined });
        this.emitProgress();
        return;
      } catch (e) {
        shot.error = String(e instanceof Error ? e.message : e);
        if (attempt < VIDEO_ATTEMPTS) await this.sleep(BACKOFF_MS * attempt);
      }
    }
    // Every take is spent. Say what the last one failed on: the run's own
    // activity is where the user watched this shot, and "could not be generated"
    // with no reason is not something anyone can act on.
    if (shot.error) {
      this.deps.emit({ type: "log", message: `Shot ${shot.id} failed — ${shot.error}` });
    }
    await this.placeFallback(shot); // never leave a hole
    this.emitProgress();
  }

  /** Watch a rendered take against its plan — best-effort: a reviewer outage
   * never blocks placement, it just goes unwatched. */
  private async reviewTake(clip: string, shot: Shot): Promise<ReviewVerdict> {
    try {
      return await this.deps.suite.review!.watch({
        videoMediaId: clip,
        action: shot.action,
        // The story spine, so the take is judged as this beat of the video —
        // not an action stranded from what it is for.
        logline: this.project.script?.logline?.trim() || this.project.brief || undefined,
        ...(shot.intent ? { intent: shot.intent } : {}),
        style: this.project.style,
        keyframeMediaId: shot.startKeyframe,
        // Identity is judged against the canonical sheets, not the keyframe —
        // a take rendered from a weaker rung (no keyframe riding) is still
        // held to the same character designs.
        castSheets: shotRefs(shot, this.project)
          .filter((r) => r.purpose === "character")
          .map((r) => ({ name: r.name || "the character", mediaId: r.mediaId })),
        narration: (shot.dialogue ?? shot.audioText).trim(),
        slotSec: frameToSec(shotDurationFrames(shot), this.fps),
      });
    } catch {
      return { ok: true };
    }
  }

  /** The audio slice a shot should be spoken over — only in provided mode, where
   * the user's audio is the spine an audio-native model lip-syncs to (or a
   * post-pass syncs). Generated mode has no such slice: the model burns each
   * shot's scripted line in from the prompt, so nothing is passed as audio. */
  private audioForShot(shot: Shot): { mediaId: string; fromSec: number; toSec: number } | undefined {
    if (this.project.audioMode !== "provided" || !this.project.audioAssetId) return undefined;
    return {
      mediaId: this.project.audioAssetId,
      fromSec: frameToSec(shot.startFrame, this.fps),
      toSec: frameToSec(shot.endFrame, this.fps),
    };
  }

  /** Hold a still for a shot whose video couldn't be made — never a black gap. */
  private async placeFallback(shot: Shot): Promise<void> {
    if (this.aborted) return; // a paused run neither spends nor places
    const still = await this.fallbackStill(shot);
    if (still) {
      await this.clearVideoPlacement(shot);
      // `still` is already an imported project media id; placing it directly
      // avoids re-importing an id the pool already holds.
      shot.clip = still;
      shot.timelineClipId = await this.deps.editor.placeClip(still, shot.startFrame, shot.endFrame, this.placementAnchors(shot));
    } else {
      // Nothing to hold — keep whatever was there rather than opening a hole.
      this.deps.emit({ type: "error", message: `Shot ${shot.id} could not be generated or filled.` });
    }
    this.updateShot(shot, { status: "failed" });
  }

  /** Source a still for a fallback: this shot's keyframe, a freshly minted one,
   * or a neighbor's frame — so a keyframe-gen failure never leaves a hole. */
  private async fallbackStill(shot: Shot): Promise<string | undefined> {
    if (shot.startKeyframe) return shot.startKeyframe;
    try {
      shot.startKeyframe = await this.screenedImage(
        `${buildPrompt(shot, this.project)} Still frame.`,
        shotRefs(shot, this.project),
        shot.action
      );
      return shot.startKeyframe;
    } catch {
      /* fall through to holding a neighbor's frame */
    }
    const idx = this.project.shots.findIndex((s) => s.id === shot.id);
    for (let i = idx - 1; i >= 0; i--) {
      const prev = this.project.shots[i];
      if (prev.clip) return prev.clip;
      if (prev.startKeyframe) return prev.startKeyframe;
    }
    for (let i = idx + 1; i < this.project.shots.length; i++) {
      const next = this.project.shots[i];
      if (next.clip) return next.clip;
      if (next.startKeyframe) return next.startKeyframe;
    }
    return undefined;
  }

  /** The run's ordering anchors for one shot's landing: every clip an earlier
   * shot still holds on the track (the take lands after the furthest of them)
   * and every clip a later shot holds (the take never slides past those — they
   * push right instead). Renders finish out of order, so this — not the plan's
   * absolute frames — is what keeps shots assembling in story order on a
   * timeline the user may be editing while the run works. */
  private placementAnchors(shot: Shot): { anchorAfterIds?: string[]; followClipIds?: string[] } {
    const shots = this.project.shots;
    const idx = shots.findIndex((s) => s.id === shot.id);
    if (idx < 0) return {};
    const held = (s: Shot) =>
      [s.timelineClipId, ...(s.replacesClipIds ?? [])].filter((id): id is string => !!id);
    const anchorAfterIds = shots.slice(0, idx).flatMap(held);
    // A re-cut's replaced clip can span several fresh shots and so be held on
    // both sides; the earlier side wins — it anchors, it must not also push.
    const anchored = new Set(anchorAfterIds);
    const followClipIds = shots
      .slice(idx + 1)
      .flatMap(held)
      .filter((id) => !anchored.has(id));
    return {
      ...(anchorAfterIds.length ? { anchorAfterIds } : {}),
      ...(followClipIds.length ? { followClipIds } : {}),
    };
  }

  private async clearVideoPlacement(shot: Shot): Promise<void> {
    if (shot.timelineClipId) {
      await this.deps.editor.removeClip(shot.timelineClipId);
      shot.timelineClipId = undefined;
    }
    // Clips a re-cut left in this shot's span — the replaced footage holds the
    // slot until the fresh take arrives, then goes with it.
    if (shot.replacesClipIds?.length) {
      for (const id of shot.replacesClipIds) await this.deps.editor.removeClip(id);
      shot.replacesClipIds = undefined;
    }
  }

  // ── Phase H: polish ──────────────────────────────────────────────────────
  private async polish(): Promise<void> {
    if (this.aborted) return;
    this.setPhase("polish");
    // Compose the bed now — after the gate and the shots — so an unapproved plan
    // never spends on one. Generated mode only: a provided audio spine is the
    // soundtrack, so nothing is laid over it. Best-effort: no music backend (or
    // one that declines) just means no bed.
    if (this.project.audioMode === "generated" && !this.project.musicAssetId && this.deps.suite.music) {
      try {
        this.deps.emit({ type: "activity", message: "Composing the music bed…" });
        const music = await this.deps.suite.music.compose({
          mood: this.project.script?.style ?? this.project.style ?? "cinematic underscore",
          durationSec: frameToSec(this.durationFrames, this.fps),
        });
        this.project.musicAssetId = await this.deps.editor.importMedia(music);
      } catch {
        this.deps.emit({ type: "log", message: "No music bed this time — assembling without one." });
      }
    }
    if (this.project.musicAssetId) {
      // Idempotent: replace the prior bed instead of stacking a second one.
      if (this.project.musicClipId) await this.deps.editor.removeAudio(this.project.musicClipId);
      this.project.musicClipId = await this.deps.editor.placeAudio(this.project.musicAssetId, 0, this.durationFrames, {
        kind: "music",
        lane: 1,
        // Under the shots' burned-in narration — there is no voice track to duck
        // the bed beneath, so it rides at a fixed underscore level.
        volume: MUSIC_BED_VOLUME,
      });
    }
    const placed = this.project.shots.filter((s) => s.timelineClipId).length;
    const failed = this.project.shots.filter((s) => s.status === "failed").length;
    this.deps.emit({
      type: "log",
      message:
        `Video assembled with ${this.deps.suite.label}: ${placed}/${this.project.shots.length} shots on the track` +
        (failed ? `, ${failed} held as a still to regenerate.` : "."),
    });
    this.setPhase("done");
    await this.save();
  }

  // ── Selective regeneration (review loop + follow-up diffs) ───────────────

  async regenerateShots(ids: string[], mutate?: (shot: Shot) => void): Promise<VideoProject> {
    const targets: Shot[] = [];
    for (const id of ids) {
      const shot = this.project.shots.find((s) => s.id === id);
      if (!shot) continue;
      // Keep timelineClipId/clip so generateAndPlace swaps them once the new
      // clip is ready — clearing them up front would open a hole if the redo
      // fails. The beat voice is untouched, so narration never restacks.
      shot.startKeyframe = undefined;
      shot.lipSynced = false;
      shot.error = undefined;
      shot.status = "pending";
      mutate?.(shot);
      targets.push(shot);
    }
    await this.save();
    await fanOut(
      targets,
      async (shot) => {
        try {
          await this.makeKeyframes(shot);
        } catch {
          /* placeFallback will source a still */
        }
        await this.generateAndPlace(shot);
      },
      this.poolOpts(0)
    );
    await this.save();
    return this.project;
  }

  /** "Make shot N wider / a close-up" — a framing note, one shot dirtied. */
  async applyShotNote(id: string, note: string): Promise<VideoProject> {
    return this.regenerateShots([id], (shot) => {
      shot.action = shot.action ? `${shot.action} ${note}`.trim() : note;
    });
  }

  /** Re-draw one shot's opening frame at the storyboard gate, before any video
   * spends. A note nudges it ("at night", "wider") and becomes part of the
   * shot's plan; with none, the frame is simply re-rolled. Only the cheap
   * keyframe is remade — the run stays parked at the gate. A no-op once the plan
   * is approved (from there `regenerateShots` re-renders the take). A failed
   * re-mint leaves the prior frame in place. */
  async reviseStoryboardFrame(id: string, note?: string): Promise<VideoProject> {
    if (this.aborted || this.project.breakdownApproved) return this.project;
    const shot = this.project.shots.find((s) => s.id === id);
    if (!shot) return this.project;
    if (note) shot.action = shot.action ? `${shot.action} ${note}`.trim() : note;
    try {
      // The nudge already rides `action` (buildPrompt carries it), so the
      // re-mint needs no separate review note.
      await this.makeKeyframes(shot);
    } catch {
      this.updateShot(shot, { status: "pending" }); // clear the spinner; the prior frame stands
    }
    await this.save();
    return this.project;
  }

  /** Re-cut a contiguous span of shots against the same audio: the segmenter
   * re-slices just that span's narration (steered by the instruction), fresh
   * shots replace the old ones between the same frame boundaries — the span
   * can become more shots or fewer — and only they render. The style, the
   * bible, and every other shot's clip stay exactly as they are; a genuinely
   * new person or place gets a bible entry and a sheet first. Each replaced
   * clip holds its slot until the first fresh shot overlapping it places. */
  async recutShots(ids: string[], instruction: string): Promise<VideoProject> {
    const list = this.project.shots;
    const first = list.findIndex((s) => s.id === ids[0]);
    const last = list.findIndex((s) => s.id === ids[ids.length - 1]);
    if (first < 0 || last < first) throw new Error("Those shots are not in this scene.");
    const span = list.slice(first, last + 1);
    const startFrame = span[0].startFrame;
    const endFrame = span[span.length - 1].endFrame;
    const spanFrames = endFrame - startFrame;
    this.deps.emit({
      type: "activity",
      message: span.length === 1 ? `Re-cutting shot ${first + 1}…` : `Re-cutting shots ${first + 1}–${last + 1}…`,
    });
    // Leave the terminal phase for the duration (persisted with the splice
    // below), so a reload mid-re-cut resumes the render through run() instead
    // of stranding pending shots behind a "done" plan.
    this.setPhase("generating");
    // The segmenter sees the span as a self-contained narration (rebased to
    // zero) plus the revision ask and the bible roster, so it reuses known
    // ids and invents one only for a genuinely new person or place.
    const roster = [...this.project.characters, ...this.project.locations]
      .map((a) => `${a.id} = ${a.name}`)
      .join("; ");
    const brief = [
      this.project.brief,
      `Revise this section: ${instruction}`,
      roster
        ? `Reuse these existing ids where they fit: ${roster}. Introduce a new char:/loc: id only for a genuinely new person or place.`
        : "",
    ]
      .filter(Boolean)
      .join("\n");
    const input = {
      transcript: this.spanWords(startFrame, endFrame),
      brief,
      durationFrames: spanFrames,
      fps: this.fps,
    };
    // Fresh ids that can never collide with surviving shots (or each other),
    // however many re-cuts the plan has been through.
    const used = new Set(list.map((s) => s.id));
    let seq = 0;
    const freshId = () => {
      let id = `shot:r${seq++}`;
      while (used.has(id)) id = `shot:r${seq++}`;
      used.add(id);
      return id;
    };
    let cut: Shot[];
    try {
      cut = repairCoverage(await this.deps.suite.breakdown.segment(input), spanFrames, this.fps, freshId);
    } catch {
      cut = repairCoverage(segmentByDuration(input, MAX_SHOT_SEC), spanFrames, this.fps, freshId);
    }
    // Back onto the timeline at absolute frames. Each fresh shot already carries
    // its own slice of the re-cut narration (repairCoverage scopes audioText per
    // sub-shot), which the video model burns in — so no beat-nesting is needed.
    const fresh = cut.map((s) => ({
      ...s,
      startFrame: s.startFrame + startFrame,
      endFrame: s.endFrame + startFrame,
    }));
    // Every fresh shot lists each replaced clip overlapping its span; the
    // first of them to place removes it (removal is idempotent). The old
    // footage holds the span until new footage starts landing, and no two
    // clips ever overlap on the track.
    for (const old of span) {
      if (!old.timelineClipId) continue;
      const overlapping = fresh.filter(
        (s) => s.startFrame < old.endFrame && s.endFrame > old.startFrame
      );
      for (const s of overlapping.length ? overlapping : [fresh[0]]) {
        (s.replacesClipIds ??= []).push(old.timelineClipId);
      }
    }
    const addedEntities = this.adoptNewEntities(fresh);
    this.project.shots = [...list.slice(0, first), ...fresh, ...list.slice(last + 1)];
    assertCoverage(this.project.shots, this.durationFrames);
    await this.save();
    this.deps.emit({ type: "breakdown", shots: this.project.shots });
    // A new entity's sheet mints before any render seeds from it, exactly like
    // a first run's design pass.
    if (addedEntities) await this.style();
    await fanOut(
      fresh,
      async (shot) => {
        try {
          await this.makeKeyframes(shot);
        } catch {
          /* placeFallback will source a still */
        }
        await this.generateAndPlace(shot);
      },
      this.poolOpts(0)
    );
    this.setPhase("done");
    await this.save();
    return this.project;
  }

  /** The words heard across a frame span, rebased to zero — the transcript
   * slice in provided mode; in generated mode, synthesized from the script
   * beats (each beat's dialogue spread evenly over its voiced span). */
  private spanWords(startFrame: number, endFrame: number): TranscriptWord[] {
    const t0 = frameToSec(startFrame, this.fps);
    const t1 = frameToSec(endFrame, this.fps);
    if (this.project.audioMode === "provided") {
      return this.project.transcript
        .filter((w) => w.t1 > t0 && w.t0 < t1)
        .map((w) => ({ ...w, t0: w.t0 - t0, t1: w.t1 - t0 }));
    }
    const beats = this.project.script?.beats ?? [];
    const spine = this.project.beatVoices ?? [];
    const words: TranscriptWord[] = [];
    spine.forEach((bv, bi) => {
      const text = beats[bi]?.dialogue.trim();
      if (!text) return;
      const parts = text.split(/\s+/).filter(Boolean);
      const beatT0 = frameToSec(bv.startFrame, this.fps);
      const per = frameToSec(bv.durationFrames, this.fps) / parts.length;
      parts.forEach((w, wi) => {
        const wt0 = beatT0 + wi * per;
        const wt1 = wt0 + per;
        if (wt1 > t0 && wt0 < t1) words.push({ t0: wt0 - t0, t1: wt1 - t0, w });
      });
    });
    return words;
  }

  /** Bible stubs for ids a re-cut introduced — style() then mints their
   * sheets like any first-run design. Returns whether anything was added. */
  private adoptNewEntities(shots: Shot[]): boolean {
    const known = new Set(
      [...this.project.characters, ...this.project.locations].map((a) => a.id)
    );
    let added = false;
    for (const shot of shots) {
      for (const id of shot.characters) {
        if (!id || known.has(id)) continue;
        known.add(id);
        this.project.characters.push({ id, kind: "character", name: id, description: shot.action });
        added = true;
      }
      const loc = shot.location;
      if (loc && !known.has(loc)) {
        known.add(loc);
        this.project.locations.push({ id: loc, kind: "location", name: loc, description: shot.action });
        added = true;
      }
    }
    return added;
  }

  /** A style change dirties everything downstream of the style bible. */
  async changeStyle(style: string): Promise<VideoProject> {
    // The new look goes back through the art director: it realizes the pinned
    // style into a fresh bible (banned tells included, trademarks translated
    // to traits) and re-dresses the cast for it — wardrobe is look. Emptying
    // the cast (in memory only — style() persists the new bible when it lands)
    // is what re-runs the design; ids re-derive from the shots.
    const prior = {
      style: this.project.style,
      negative: this.project.negative,
      characters: this.project.characters,
      locations: this.project.locations,
    };
    this.project.style = style;
    this.project.negative = undefined;
    this.project.characters = [];
    this.project.locations = [];
    try {
      await this.style();
      await this.regenerateShots(this.project.shots.map((s) => s.id));
    } catch (e) {
      // A failed redesign must not strand the project bible-less: every later
      // regenerate_shot would render with no identity anchors. The old cast
      // (or the new one, if the design landed and only the re-render failed)
      // stays in place, and the project returns to its terminal phase.
      if (this.project.characters.length === 0) Object.assign(this.project, prior);
      this.setPhase("done");
      await this.save().catch(() => {});
      throw e;
    }
    // Restore the terminal phase so a later resume doesn't re-run polish (which
    // would otherwise re-place the music bed).
    this.setPhase("done");
    await this.save();
    return this.project;
  }

  shotIdByNumber(n: number): string | undefined {
    return this.project.shots[n - 1]?.id;
  }

  // ── helpers ──────────────────────────────────────────────────────────────

  private referencedAssets(): VideoAsset[] {
    const usedChars = new Set(this.project.shots.flatMap((s) => s.characters));
    const usedLocs = new Set(this.project.shots.map((s) => s.location));
    return [
      ...this.project.characters.filter((c) => usedChars.has(c.id)),
      ...this.project.locations.filter((l) => usedLocs.has(l.id)),
    ];
  }

  private async importedImage(prompt: string, refs: RefAsset[]): Promise<string> {
    const raw = await this.deps.suite.image.generate({ prompt, refs, aspect: this.aspect });
    return this.deps.editor.importMedia(raw);
  }

  /** Mint an image and hold it to the production's benchmark: the art-director
   * gate judges it against the anchor sheet before it seeds anything paid, and
   * a declined take re-mints once with the critique in the prompt. The second
   * take lands either way — the gate improves frames, it never blocks the run. */
  private async screenedImage(prompt: string, refs: RefAsset[], subject: string): Promise<string> {
    let mediaId = await this.importedImage(prompt, refs);
    const benchmark = styleAnchor(this.project)?.mediaId;
    const gate = this.deps.suite.review?.frame;
    if (!benchmark || !gate) return mediaId;
    try {
      const verdict = await gate({
        imageMediaId: mediaId,
        benchmarkMediaId: benchmark,
        style: this.project.style,
        subject,
      });
      if (!verdict.ok) {
        const note = verdict.note ?? "match the benchmark sheet exactly — same artist, same palette";
        this.deps.emit({ type: "log", message: `Redrawing an off-style frame — ${note}` });
        mediaId = await this.importedImage(`${prompt} Note from the art director: ${note}.`, refs);
      }
    } catch {
      // The gate is best-effort; a frame it couldn't judge still serves.
    }
    return mediaId;
  }

  private emitProgress(): void {
    const placed = this.project.shots.filter((s) => s.timelineClipId).length;
    this.deps.emit({ type: "progress", placed, total: this.project.shots.length });
  }

  private setPhase(phase: VideoPhase, note?: string): void {
    this.project.phase = phase;
    if (phase === "done" || phase === "failed") this.project.endedAt = Date.now();
    this.deps.emit({ type: "phase", phase, note });
  }

  private updateShot(shot: Shot, patch: Partial<Shot>): void {
    Object.assign(shot, patch);
    void this.save();
    this.deps.emit({ type: "shot:update", shot });
  }

  private poolOpts(retries: number) {
    return {
      concurrency: this.deps.concurrency ?? 6,
      retries,
      backoffMs: BACKOFF_MS,
      ...(this.deps.sleep ? { sleep: this.deps.sleep } : {}),
    };
  }

  private sleep(ms: number): Promise<void> {
    return this.deps.sleep ? this.deps.sleep(ms) : new Promise((r) => setTimeout(r, ms));
  }

  /** Persist, serialized so concurrent updates never interleave writes. An
   * aborted run stops persisting so it can't overwrite the plan the live run
   * (or a switched-to project) now owns. */
  private save(): Promise<void> {
    if (this.aborted) return Promise.resolve();
    this.project.updatedAt = this.project.updatedAt + 1; // monotonic without Date in tests
    this.saveChain = this.saveChain.then(() => this.deps.persist(this.project)).catch(() => {});
    return this.saveChain;
  }
}

/** Rough spoken length of a line for planning, before the real voiceover
 * exists — ~165 words/min, floored so even a couple of words hold a beat. */
function estimateSpokenSeconds(dialogue: string): number {
  const words = dialogue.trim().split(/\s+/).filter(Boolean).length;
  return Math.max(1.2, (words / 165) * 60);
}

/** Planning length for a beat before any voiceover exists: a spoken beat scales
 * with its word count; a silent, action-only beat has no line to time, so it
 * holds the scripted `approxSeconds` instead of collapsing to the floor. */
function estimateBeatSeconds(beat: ScriptBeat): number {
  return beat.dialogue.trim() ? estimateSpokenSeconds(beat.dialogue) : Math.max(1.2, beat.approxSeconds || 0);
}

/** Split one beat's span into contiguous shots each no longer than `maxFrames`,
 * distributing the remainder so the pieces stay as even as possible. */
function splitBeat(start: number, frames: number, maxFrames: number): [number, number][] {
  const parts = Math.max(1, Math.ceil(frames / maxFrames));
  const base = Math.floor(frames / parts);
  let rem = frames - base * parts;
  const out: [number, number][] = [];
  let s = start;
  for (let i = 0; i < parts; i++) {
    const size = base + (rem > 0 ? 1 : 0);
    if (rem > 0) rem--;
    const e = i === parts - 1 ? start + frames : s + size;
    out.push([s, e]);
    s = e;
  }
  return out;
}
