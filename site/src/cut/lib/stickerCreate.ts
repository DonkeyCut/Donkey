"use client";

/**
 * The custom-sticker pipeline: prompt → hosted image generation (die-cut
 * framing folded around the idea) → background removal → white outline →
 * saved as an origin-"sticker" project asset. The Elements panel and the
 * assistant's create_sticker tool share this one path.
 */

import type { AssetRef } from "./assetRef";
import { bytesFromBase64 } from "./bytes";
import { makeStickerCutout } from "./cutout";
import { promptAndImages } from "./generate";
import { hostedPost } from "./hosted";
import { uploadProjectImage } from "./media";
import { useEditor } from "./store";
import { mediaSlug, type MediaAsset } from "./types";

/** The die-cut framing that makes a generation come back sticker-shaped: one
 * centered subject on a plain background the cutout pass can lift it off. */
const STICKER_FRAMING =
  "Sticker style: one centered subject with a bold, clean silhouette, on a plain " +
  "solid light-gray background, no text, no other objects, no border.";

const stickerPrompt = (idea: string) => `A single ${idea.trim()}. ${STICKER_FRAMING}`;

export type StickerStage = "generating" | "cutting" | "saving";

/** Generate, cut out, and save a custom sticker; the asset is registered in
 * the open project. References ride along as input images, composed the same
 * way the image panel composes them. Throws user-facing errors (sign-in,
 * credits, provider). */
export async function createCustomSticker(
  projectId: string,
  idea: string,
  onStage?: (stage: StickerStage) => void,
  opts: { refs?: AssetRef[] } = {}
): Promise<MediaAsset> {
  onStage?.("generating");
  const refs = opts.refs ?? [];
  // With references the composed prompt describes the picture, so the framing
  // follows it; on its own the idea is folded into the framing directly.
  const { prompt: composed, images } = await promptAndImages(
    "image",
    idea,
    refs,
    refs.length > 0,
    Infinity
  );
  const res = await hostedPost("/api/inference/assets", {
    kind: "image",
    prompt: refs.length > 0 ? `${composed}\n\n${STICKER_FRAMING}` : stickerPrompt(idea),
    ...(images.length > 0 ? { inputs: { images } } : {}),
    parameters: { aspectRatio: "1:1", imageSize: "1K" },
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? "Image generation failed.");
  }
  const gen = (await res.json()) as { outputs: { dataBase64?: string; contentType?: string }[] };
  const out = gen.outputs?.find((o) => o.dataBase64);
  if (!out?.dataBase64) throw new Error("The provider returned no image.");
  const source = new Blob([bytesFromBase64(out.dataBase64)], {
    type: out.contentType ?? "image/png",
  });

  onStage?.("cutting");
  // A failed cutout still yields a sticker — the uncut square — rather than a
  // dead end; regenerating retries the cut.
  const cut =
    (await makeStickerCutout(source, { plainBackdrop: true }).catch(() => null)) ?? source;

  onStage?.("saving");
  const asset = await uploadProjectImage(projectId, cut, `${mediaSlug(idea, "sticker")}.png`, {
    name: idea,
    origin: "sticker",
  });
  useEditor.getState().addAsset(asset);
  return asset;
}
