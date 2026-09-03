"use client";

/**
 * The media roles — image, video, voice — over the exact browser-side
 * generation the panels and chat already use (`useGenerate`, `tts`). Each runs
 * on the user's Donkey session and credits and lands its output as a real
 * project asset, so what these return is a placeable asset id and the editor
 * bridge's `importMedia` has nothing left to do.
 *
 * Two shaping choices matter for the assembled cut:
 * - Video is NOT audio-native here: the model renders each shot's audio itself
 *   from the prompt (which states the shot's line), and there is no way to feed
 *   it our own track. In a generated scene that burned-in narration is the point
 *   — the orchestrator places the clip unmuted and lays no separate voice track.
 *   In a provided-audio scene the user's audio is the spine, so the orchestrator
 *   mutes the clip's own audio instead.
 * - Cast identity is anchored per shot, strongest signal first (see the ladder
 *   in shotAttempts.ts): the shot's keyframe — already rendered with the cast's
 *   reference images, so it IS the cast — seeds the render as its literal
 *   opening frame; if the anchor is blocked, the character/location reference
 *   images condition a reference-to-video render; text-only is the last
 *   resort — for a cast shot it runs only when the provider refused the image
 *   anchor itself, and its take still faces the reviewer's identity gate
 *   before placing. Each rung's prompt folds in the bible descriptions of
 *   exactly the cast that doesn't ride that call as an image
 *   (describeUnanchored), so the text-only rung renders against the full
 *   written identity — the same fixed words every shot — instead of a bare
 *   action line.
 * - The model picks each clip's length (up to ~10s) — there is no duration
 *   knob — and always covers the shot's slot, so the editor trims the take to
 *   the exact shot.
 */

import { refFromAsset, type AssetRef } from "../../assetRef";
import { tagChatAsset } from "../../chatAssets";
import { useGenerate, videoJobSettlement } from "../../generate";
import { enrichAsset } from "../../media";
import { useEditor } from "../../store";
import { DEFAULT_VOICE, synthesizeSpeech } from "../../tts";
import { clampVideoDuration, videoModel } from "../../videoModels";
import { reportActivity } from "../activity";
import { findRunAsset, stockAssetInDoc } from "../docWriter";
import { buildShotAttempts } from "../shotAttempts";
import type { ImageRole, VideoRole, VoiceRole } from "../capabilities";
import { refRoleNote } from "../prompt";
import type { RefAsset } from "../types";

/** Resolve the pipeline's media-id references to the project assets the
 * generators take, dropping any that are no longer in the project. Resolution
 * goes through findRunAsset so a background run (its project closed, or the
 * user switched away mid-render) keeps its identity anchors — the open
 * editor's asset list only covers whatever project is on screen. */
async function refsToAssetRefs(projectId: string, refs: RefAsset[]): Promise<AssetRef[]> {
  const out: AssetRef[] = [];
  for (const r of refs) {
    const a = await findRunAsset(projectId, r.mediaId);
    if (a) out.push(refFromAsset(a));
  }
  return out;
}

// Seconds a scene take renders beyond its slot, so the dailies review has a
// window to choose inside and rounding never leaves the slot short.
const SLOT_HEADROOM_SECONDS = 1;

export function makeImageRole(projectId: string, chatId?: string): ImageRole {
  return {
    async generate(input) {
      // The refs ride as bare pixels, so the prompt states each one's role —
      // sheets fix the cast, style references contribute technique only.
      const roles = refRoleNote(input.refs);
      const job = await useGenerate.getState().generateImage(projectId, roles ? `${input.prompt} ${roles}` : input.prompt, {
        refs: await refsToAssetRefs(projectId, input.refs),
        aspect: input.aspect,
        // The prompt is already complete (buildPrompt folds in style + setting);
        // the refs ride as identity anchors, not a prompt to rewrite.
        composeRefs: false,
        // Chat ownership rides the job from creation, so keyframes and reference
        // images never touch the Image panel — job row, tile, or badge — even
        // when the render errors or lands after the user moved on.
        ...(chatId ? { chatId } : {}),
      });
      if (job.status !== "done" || !job.assetId) {
        throw new Error(job.error || "Image generation failed.");
      }
      return job.assetId;
    },
  };
}

export function makeVideoRole(projectId: string, chatId?: string): VideoRole {
  return {
    // The model renders its own audio from the prompt; it takes no audio input,
    // so it never lip-syncs to an external track.
    audioNative: false,
    async generate(input) {
      // The identity ladder: each rung renders from a weaker identity anchor,
      // its prompt growing the written identity of whatever no longer rides as
      // an image, and a shot takes the first rung that lands. A render takes
      // one anchor kind per call (seed OR references), so the rungs are
      // distinct requests, not one combined one.
      // The shot's stable identity, stamped on every job this render starts so
      // a resumed run re-adopts exactly its own in-flight take.
      const genKey = input.shotId ? `${projectId}:${input.shotId}` : undefined;
      // The shot renders at the length its slot needs, rounded up and given a
      // second of headroom, clamped onto what the model renders. Up covers the
      // slot: a take shorter than its slot gets speed-stretched to fill it
      // (fillSlot), which drags the burned-in narration down with it. The
      // headroom is what the dailies review picks its window inside — the
      // placement clamps the chosen start to what the take has spare, so a
      // take cut exactly to the slot leaves the review nothing to choose.
      const durationSeconds =
        input.durationSec === undefined
          ? undefined
          : clampVideoDuration(Math.ceil(input.durationSec) + SLOT_HEADROOM_SECONDS);
      const base = {
        aspect: input.aspect,
        ...(durationSeconds !== undefined ? { durationSeconds } : {}),
        ...(input.negativePrompt ? { negativePrompt: input.negativePrompt } : {}),
      };
      // The seed keyframe resolves wherever the run's project lives — the
      // store when open, the persisted doc when the user switched away.
      const keyframe = input.startKeyframe
        ? await findRunAsset(projectId, input.startKeyframe)
        : undefined;
      // Identity and place anchors only — a user style reference is a look,
      // not a cast member, and must never ride as an asset to keep consistent.
      // The ref↔anchor pairing survives so each rung's prompt can name exactly
      // the cast that does NOT ride that call as an image.
      const identityRefs = input.refs.filter(
        (r) => r.purpose === "character" || r.purpose === "location"
      );
      const resolved: { ref: RefAsset; anchor: AssetRef }[] = [];
      for (const r of identityRefs) {
        const a = await findRunAsset(projectId, r.mediaId);
        if (a) resolved.push({ ref: r, anchor: refFromAsset(a) });
      }
      const riding = resolved.slice(0, videoModel("omni").maxReferenceImages);
      // The rung policy — order, anchor strength, the policy-gated text rung —
      // is pure data built in shotAttempts.ts (locked by the self-test); this
      // role only resolves the assets it rides on.
      const attempts = buildShotAttempts({
        prompt: input.prompt,
        refs: input.refs,
        base,
        keyframe: keyframe ? refFromAsset(keyframe) : undefined,
        anchors: riding.map((p) => p.anchor),
        ridingIds: new Set(riding.map((p) => p.ref.mediaId)),
      });
      // A reload may have left this exact shot's render in flight — adopt the
      // resumed job's result instead of billing a second take. The match is
      // the shot's own identity, never the prompt text: two shots can share a
      // prompt and each still owns its own take.
      // Whether a landed rung rode pixels — the retake policy needs to know a
      // take held its identity by anchor or by words alone.
      const anchoredRung = (rung?: number) =>
        rung !== undefined &&
        Boolean(attempts[rung]?.opts?.refs || attempts[rung]?.opts?.referenceImages);
      const inFlight = genKey
        ? useGenerate
            .getState()
            .jobs.find((j) => j.kind === "video" && j.status === "running" && j.genKey === genKey)
        : undefined;
      if (inFlight) {
        const settledJob = await videoJobSettlement(inFlight.id);
        if (settledJob?.status === "done" && settledJob.assetId)
          return { mediaId: settledJob.assetId, anchored: anchoredRung(settledJob.rung) };
      }
      // The ladder walk itself — one job spanning the rungs, next rung on any
      // failure, fail-fast on an empty balance — lives in generateVideoLadder,
      // shared with chat's one-off renders.
      const job = await useGenerate.getState().generateVideoLadder(projectId, attempts, {
        ...(genKey ? { genKey } : {}),
        // Chat ownership rides the job from creation, so a shot never touches
        // the Video panel — job row, tile, or badge — even when the render
        // errors or lands after the user moved on. Once placed on the timeline
        // it's protected from thread-deletion by the clip.
        ...(chatId ? { chatId } : {}),
        onAttempt: (rung) =>
          reportActivity(
            rung === 0
              ? "Animating the frame — a minute or two…"
              : "That take failed — retrying on a fallback renderer…",
            projectId
          ),
      }).settled;
      if (job.status === "done" && job.assetId)
        return { mediaId: job.assetId, anchored: anchoredRung(job.rung) };
      throw new Error(job.error || "Video generation failed.");
    },
  };
}

/** The scene voice capability. Retained in the suite and the model-swap
 * registry, but the current orchestrator no longer places a voice track — a
 * generated scene's narration is burned into each shot by the video model. */
export function makeVoiceRole(projectId: string, chatId?: string): VoiceRole {
  return {
    async speak(input) {
      const { asset } = await synthesizeSpeech(projectId, [{ text: input.script, at: 0 }], {
        voice: input.voice || DEFAULT_VOICE,
        ...(input.direction ? { direction: input.direction } : {}),
        name: "Narration",
      });
      // synthesizeSpeech imports the file but leaves it to the caller to stock
      // it, so the spine placement can find the asset: the live store when
      // this run's project is open, its persisted doc when the user has moved
      // on — a background run keeps its narration durable either way.
      if (useEditor.getState().projectId === projectId) {
        useEditor.getState().addAsset(asset);
        // Chat-owned, so the narration never shows in the Audio panel's
        // voiceover list — it's part of the run, placed on the soundtrack.
        // Only the run's own thread id: the ambient chat context is whatever
        // thread happens to be open when a background render lands.
        if (chatId) tagChatAsset(asset.id, chatId);
        void enrichAsset(asset);
      } else {
        if (chatId) {
          asset.origin = "chat";
          asset.chatId = chatId;
        }
        await stockAssetInDoc(projectId, asset).catch(() => {});
      }
      return { mediaId: asset.id, durationSec: asset.duration };
    },
  };
}
