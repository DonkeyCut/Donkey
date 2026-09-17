"use client";

/**
 * The scene shot's identity ladder as data: which rungs a shot renders
 * through, in strength order, and when each may run. Pure — media.ts resolves
 * the assets and hands them in, so the self-test can prove the ladder policy
 * (rung order, anchor strength, the policy-gated text rung) without a browser
 * or a credit spent.
 */

import { classifyProviderFailure } from "../providerFailure";
import type { AssetRef } from "../assetRef";
import type { VideoAttempt } from "../videoLadder";
import type { VideoGenOptions } from "../generate";
import { describeUnanchored } from "./prompt";
import type { RefAsset } from "./types";

/** Whether a render failure means the provider refused the image anchor
 * itself — a safety policy on what the picture shows, an unreadable format —
 * rather than the render going wrong. Keyed on the provider's refusal, never
 * on what or who the content depicts. */
export async function anchorRefused(err: string | null): Promise<boolean> {
  if (err === null) return false;
  return (await classifyProviderFailure(err)) === "content_refused";
}

export interface ShotAttemptArgs {
  prompt: string;
  /** The shot's full reference set (with purposes) — cast detection and the
   * written identities of whatever doesn't ride a given rung as pixels. */
  refs: RefAsset[];
  /** Options every rung shares (aspect, negative prompt). */
  base: Omit<VideoGenOptions, "onDone" | "chatId" | "genKey">;
  /** The shot's approved opening frame, resolved — the strongest anchor. */
  keyframe?: AssetRef;
  /** Resolved identity anchors (cast/location sheets), already capped to the
   * model's reference limit. */
  anchors: AssetRef[];
  /** The media ids riding as anchors — their cast skips the written identity. */
  ridingIds: Set<string>;
}

/** Build the ladder: keyframe seed → reference-to-video → text-only. Words
 * hold a face far worse than pixels, so a cast shot's text-only rung is
 * reserved for the failures an image anchor can't survive — the provider
 * refusing the anchor itself (anchorRefused above). An ordinary render
 * failure on the last rung fails the whole attempt back to the orchestrator's
 * retake (a fresh keyframe, fresh dice); and whatever the text rung renders
 * still faces the reviewer's identity gate before it places. */
export function buildShotAttempts(a: ShotAttemptArgs): VideoAttempt[] {
  const hasCast = a.refs.some((r) => r.purpose === "character");
  const imageAnchored = Boolean(a.keyframe) || a.anchors.length > 0;
  return [
    // 1. The keyframe as the literal first frame. It was rendered from the
    //    cast's reference images, so it carries identity, wardrobe, setting,
    //    and framing in one anchor — the strongest continuity there is. The
    //    prompt adds one clause AGREEING with those pixels: without it a model
    //    can re-render the scene in its own medium (3D CGI from a hand-drawn
    //    frame) instead of animating the artwork it was given.
    ...(a.keyframe
      ? [{
          prompt: `${a.prompt} The video continues this exact opening frame — keep its artwork, medium, and rendering technique unchanged.`,
          opts: {
            ...a.base,
            refs: [a.keyframe],
            composeRefs: false as const,
          },
        }]
      : []),
    // 2. Reference-to-video on the cast sheets themselves — identity holds,
    //    composition is the model's again; cast beyond the reference cap is
    //    described in the prompt instead.
    ...(a.anchors.length > 0
      ? [{
          prompt: describeUnanchored(a.prompt, a.refs, a.ridingIds),
          opts: {
            ...a.base,
            referenceImages: a.anchors,
          },
        }]
      : []),
    // 3. Text-only — the full written identity of every cast member rides the
    //    prompt. For cast shots this rung runs only when the provider refused
    //    the image anchor itself.
    {
      prompt: describeUnanchored(a.prompt, a.refs, new Set()),
      opts: { ...a.base },
      ...(hasCast && imageAnchored ? { gate: anchorRefused } : {}),
    },
  ];
}
