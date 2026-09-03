"use client";

/**
 * The dailies reviewer — a multimodal judgment role that watches a rendered
 * take the way an editor screens footage: sampled frames of the clip ride to
 * the hosted model with the shot's planned action and the words heard over it,
 * and the verdict either passes the take (with the best in-point for the slot)
 * or declines it with a note the retake prompt carries.
 *
 * Frames come from the same in-browser capture the visual-subtitles pipeline
 * uses, so nothing renders server-side and the whole check is one cheap
 * structured call.
 */

import { geminiModelRoleNames } from "@/lib/inference/gemini-models";
import { hostedPost } from "../../hosted";
import { captureVideoFrames } from "../../visualFrames";
import { findRunAsset } from "../docWriter";
import { imagePart } from "./refImages";
import type {
  FrameCheckInput,
  ReviewInput,
  ReviewRole,
  ReviewVerdict,
  StoryboardInput,
  StoryboardVerdict,
} from "../capabilities";

const MAX_FRAMES = 8;
/** Aim for one frame every ~1s of take. */
const SECONDS_PER_FRAME = 1;

const REVIEW_INSTRUCTIONS = `You are a film editor reviewing one rendered take against its shot plan.
Reply with JSON only: {"ok": boolean, "note": string, "offModel": boolean, "medium": string, "frameMedium": string, "fromSec": number}
- medium classifies the TAKE's rendering medium from its frames alone: "hand-drawn-2d" (ink or drawn outlines, flat or cel shading, painted texture), "3d-cgi" (specular highlights, smooth volumetric shading, ambient occlusion, plastic-like surfaces, camera depth of field), "live-action", "stop-motion", or "other". frameMedium is the same classification for the approved opening frame ("" when none is shown). Classify each independently from what you SEE.
Rules:
- ok is whether the take shows the planned action and its subject. Judge content — the right person doing the right thing in the right place — and forgive small details.
- When a cast member's design sheet is shown, the take's character must read as that exact design: the same face shape, eye style, hair silhouette, and body proportions — and the sheet's outfit, except attire the planned action itself changes (a uniform, swimwear, a costume): then the new clothes are the plan's and only the character must match. A character who reads as a DIFFERENT design — rounder or sharper features, different hair, a redesigned face — is an automatic fail even if the clothing colors match: set offModel true and name the drift ("the boy is a round-faced toddler design, not the sheet's spiky-haired 8-year-old").
- Judge the MEDIUM strictly against the plan's look: a take in the wrong medium — live-action or photorealistic footage when the look is animated or illustrated, or the reverse — is an automatic fail with offModel true; note it as direction for the retake ("render as hand-drawn 2D animation, not live-action"). 3D CGI when the look is hand-drawn 2D is the wrong medium.
- When the shot's approved opening frame is shown, the take must also match its rendering technique — lineweight, shading, palette, texture. A take whose technique visibly differs from that frame is an automatic fail with offModel true; name the difference as retake direction ("match the opening frame's flat pastel rendering, not cel-shaded anime"). Within the right medium and technique, forgive stylistic detail. offModel is true ONLY for these wrong-world flaws — a wrong character design, medium, or technique; it is false for every other flaw (weak action, on-screen text, framing, editing artifacts).
- Any rendered text is an automatic fail: captions, subtitles, speech bubbles, titles, watermarks, or readable signs — note it as "remove every trace of on-screen text". A split screen, stacked panels, or a storyboard collage is also an automatic fail: the take must be one single continuous shot.
- Baked-in editing effects are an automatic fail: transition frames, fades to black or white, motion-blur smears, borders, black bars boxing the picture (letterboxing or pillarboxing), or blurred letterbox bands — the picture must fill the frame edge to edge; the editor adds transitions later.
- A sideways take is an automatic fail: the composition must be upright for its frame — level horizon, people and gravity pointing down. A scene rendered rotated 90° to fit (walls or a pool running vertically, a subject lying sideways) fails; note it as "compose the scene upright for the vertical frame".
- note, when ok is false, is one short sentence naming what is wrong, written as direction for the retake ("the boy is reading, the plan wants him swimming").
- fromSec is where the needed window should start inside the take so its best moment lands in the window; 0 when the opening works. Stay within the take.`;

const IDENTITY_INSTRUCTIONS = `You compare character designs for a production.
Reply with JSON only: {"sameDesign": boolean, "drift": string}
The first image is the canonical design sheet. The frames after it show a character in a rendered shot — possibly at a distance, in motion, or seen from behind. Judge STRUCTURE, not rendering detail: head and hair silhouette, face shape and eye style when visible, body proportions, and the outfit with its exact colors — except attire the stated shot plan changes (a uniform, swimwear, a costume): that outfit is the plan's, not drift, so judge everything but the clothes. Distance or motion blur losing fine detail is fine; a DIFFERENT design is not — a rounder or simplified head, different hair silhouette, or a redesigned face means sameDesign false, as does a changed outfit the plan did not call for. Seen only from behind or far away, judge silhouette (and outfit, when the plan keeps it) — and silhouette includes head shape: a round or bean-shaped head where the sheet has an angular or spiky-haired one is a DIFFERENT design at any distance. drift, when false, is one short retake direction naming the difference ("a bean-headed chibi with dot eyes — match the sheet's spiky-haired detailed anime boy").`;

const STORYBOARD_INSTRUCTIONS = `You are a director reviewing a storyboard before it goes to camera. The images are the ordered opening frames of consecutive shots in ONE continuous short video; judge them as a sequence that must tell the logline's story.
Reply with JSON only: {"panels": [{"ok": boolean, "note": string}]} — exactly one entry per panel, in the order given.
Rules:
- ok is whether this panel earns its place in the story: it depicts its own beat AND moves the story forward from the panel before it. A frame that shows the wrong subject or action for its beat, merely repeats the previous panel without progressing, or is generic filler any beat could use, is not ok.
- Continuity between panels is part of the story: a recurring character and their wardrobe, a named prop the story carries, the location, and the time of day stay consistent from panel to panel unless a beat itself changes them. A panel that silently drops a carried prop, restyles a character, or teleports the setting is not ok.
- Judge story and continuity, NOT drawing polish — a separate art pass handles technique. Forgive small rendering detail, camera choice, and pose.
- note, when ok is false, is one short retake direction for THAT frame naming what to change so it carries the story ("show the boy still holding the red kite from the last panel, now running toward the shore"). Empty string when ok is true.
- Return one entry per panel in order. A panel that works is {"ok": true, "note": ""}.`;

const FRAME_INSTRUCTIONS = `You are a production's art director signing off one drawn frame against the production's benchmark sheet.
Reply with JSON only: {"ok": boolean, "note": string}
Rules:
- The frame must look drawn by the same artist as the benchmark: the same medium, line weight, shading system, finish, and palette. A recurring garment or prop keeps its exact color — a shirt that reads as a different yellow than the benchmark's fails — except attire the frame's stated subject changes (a uniform, swimwear, a costume): then the new clothes are correct and only the artist's technique must match. Judge the rendering, not the composition: a different subject, pose, camera, or setting is expected and fine.
- Any split screen, stacked panels, storyboard collage, visible seam between two pictures, on-screen text, letterboxing or black bars, or sideways composition is an automatic fail.
- note, when ok is false, is one short retake direction naming the difference ("thicker outlines and a warmer, deeper yellow tee — match the benchmark's flat pastel shading").`;

function frameTimes(clipSec: number): number[] {
  const count = Math.min(MAX_FRAMES, Math.max(3, Math.round(clipSec / SECONDS_PER_FRAME)));
  return Array.from({ length: count }, (_, i) => ((i + 0.5) * clipSec) / count);
}

function splitDataUrl(dataUrl: string): { mimeType: string; data: string } | null {
  const m = /^data:([^;,]+);base64,(.+)$/.exec(dataUrl);
  return m ? { mimeType: m[1], data: m[2] } : null;
}

export function makeReviewRole(projectId: string): ReviewRole {
  return {
    async frame(input: FrameCheckInput): Promise<ReviewVerdict> {
      const [candidate, benchmark] = await Promise.all([
        findRunAsset(projectId, input.imageMediaId).then((a) => (a ? imagePart(a.url) : null)),
        findRunAsset(projectId, input.benchmarkMediaId).then((a) => (a ? imagePart(a.url) : null)),
      ]);
      // No pictures, no judgment — an unreadable frame passes rather than
      // blocking the run on the gate's own plumbing.
      if (!candidate || !benchmark) return { ok: true };
      const content: Record<string, unknown>[] = [
        {
          text: `Sign off this frame for the production.
The plan's look: ${input.style || "(none written — judge against the benchmark alone)"}
The frame should show: ${input.subject}
The benchmark sheet — the artist to match:`,
        },
        { type: "input_image", dataBase64: benchmark.data, mimeType: benchmark.mimeType },
        { text: "The frame to judge:" },
        { type: "input_image", dataBase64: candidate.data, mimeType: candidate.mimeType },
      ];
      const res = await hostedPost("/api/inference/responses", {
        donkeyProvider: "gemini",
        model: geminiModelRoleNames.review,
        instructions: FRAME_INSTRUCTIONS,
        response_format: { type: "json_object" },
        input: [{ role: "user", content }],
      });
      if (!res.ok) throw new Error("The review model is unavailable.");
      const body = (await res.json()) as { output_text?: string };
      const parsed = JSON.parse(body.output_text ?? "{}") as Record<string, unknown>;
      const ok = parsed.ok !== false;
      const note = typeof parsed.note === "string" ? parsed.note.trim() : "";
      return { ok, ...(note ? { note } : {}) };
    },

    async storyboard(input: StoryboardInput): Promise<StoryboardVerdict> {
      const allOk = (): StoryboardVerdict => ({
        notes: input.panels.map((p) => ({ shotId: p.shotId, ok: true })),
      });
      // Only panels whose frame resolves ride to the model — a missing frame
      // has nothing to judge and passes. Numbered contiguously so the panel
      // order the model replies in maps straight back to these shots.
      const seen: { shotId: string; part: { data: string; mimeType: string } }[] = [];
      const content: Record<string, unknown>[] = [
        {
          text: `Review this storyboard as one continuous short video, frames in order.
The story (logline): ${input.logline || "(none written)"}
The look: ${input.style || "(none)"}`,
        },
      ];
      for (const p of input.panels) {
        const asset = p.frameMediaId ? await findRunAsset(projectId, p.frameMediaId) : null;
        const part = asset ? await imagePart(asset.url) : null;
        if (!part) continue;
        seen.push({ shotId: p.shotId, part });
        content.push({
          text: `Panel ${seen.length}${p.intent ? ` — purpose: ${p.intent}` : ""}: ${
            p.action || "(no action written)"
          }${p.narration ? ` — narration: "${p.narration}"` : ""}`,
        });
        content.push({ type: "input_image", dataBase64: part.data, mimeType: part.mimeType });
      }
      // Nothing to compare in isolation — a lone frame can't fail continuity.
      if (seen.length < 2) return allOk();
      const res = await hostedPost("/api/inference/responses", {
        donkeyProvider: "gemini",
        model: geminiModelRoleNames.review,
        instructions: STORYBOARD_INSTRUCTIONS,
        response_format: { type: "json_object" },
        input: [{ role: "user", content }],
      });
      if (!res.ok) throw new Error("The review model is unavailable.");
      const body = (await res.json()) as { output_text?: string };
      const parsed = JSON.parse(body.output_text ?? "{}") as Record<string, unknown>;
      const verdicts = Array.isArray(parsed.panels) ? parsed.panels : [];
      const bySeen = new Map<string, StoryboardVerdict["notes"][number]>();
      seen.forEach((s, i) => {
        const v = (verdicts[i] ?? {}) as Record<string, unknown>;
        const ok = v.ok !== false;
        const note = typeof v.note === "string" ? v.note.trim() : "";
        bySeen.set(s.shotId, { shotId: s.shotId, ok, ...(!ok && note ? { note } : {}) });
      });
      // Every panel gets a verdict; the ones with no frame default to ok.
      return {
        notes: input.panels.map(
          (p) => bySeen.get(p.shotId) ?? { shotId: p.shotId, ok: true }
        ),
      };
    },

    async watch(input: ReviewInput): Promise<ReviewVerdict> {
      // The take resolves wherever the run's project lives — store when open,
      // persisted doc when the user switched away mid-render.
      const asset = await findRunAsset(projectId, input.videoMediaId);
      if (!asset || asset.type !== "video") throw new Error("No take to review.");
      const clipSec = Math.max(0.1, asset.duration);
      const frames = await captureVideoFrames(asset.url, frameTimes(clipSec));
      if (frames.length === 0) throw new Error("Could not sample the take.");
      // Each cast sheet rides both the main review and the identity check —
      // resolve and encode it once per take, not once per use.
      const sheetImages = new Map<string, Awaited<ReturnType<typeof imagePart>>>();
      const sheetImage = async (mediaId: string) => {
        if (!sheetImages.has(mediaId)) {
          const sheetAsset = await findRunAsset(projectId, mediaId);
          sheetImages.set(mediaId, sheetAsset ? await imagePart(sheetAsset.url) : null);
        }
        return sheetImages.get(mediaId) ?? null;
      };
      const content: Record<string, unknown>[] = [
        {
          text: `Review this take, shown as frames sampled along its ${clipSec.toFixed(1)}s.
${input.logline ? `The video's story: ${input.logline}\n` : ""}${input.intent ? `This shot's job in that story: ${input.intent}\n` : ""}Planned action: ${input.action || "(none written — judge against the narration)"}
The plan's look: ${input.style || "(none — judge content only)"}
Narration heard over the shot: ${input.narration ? `"${input.narration}"` : "(none)"}
The timeline slot needs ${input.slotSec.toFixed(1)}s of this take.`,
        },
      ];
      let keyframeShown = false;
      if (input.keyframeMediaId) {
        const kf = await findRunAsset(projectId, input.keyframeMediaId);
        const img = kf ? await imagePart(kf.url) : null;
        if (img) {
          content.push({ text: "The shot's approved opening frame — the production's look:" });
          content.push({ type: "input_image", dataBase64: img.data, mimeType: img.mimeType });
          keyframeShown = true;
        }
      }
      // The cast's canonical designs — identity is judged against these, not
      // the keyframe, so a take rendered without the keyframe anchor is still
      // held to the same character.
      for (const sheet of input.castSheets ?? []) {
        const img = await sheetImage(sheet.mediaId);
        if (img) {
          content.push({ text: `Design sheet for the character "${sheet.name}":` });
          content.push({ type: "input_image", dataBase64: img.data, mimeType: img.mimeType });
        }
      }
      for (const f of frames) {
        const img = splitDataUrl(f.image);
        if (!img) continue;
        content.push({ text: `Frame at ${f.at.toFixed(1)}s:` });
        content.push({ type: "input_image", dataBase64: img.data, mimeType: img.mimeType });
      }
      const res = await hostedPost("/api/inference/responses", {
        donkeyProvider: "gemini",
        model: geminiModelRoleNames.review,
        instructions: REVIEW_INSTRUCTIONS,
        response_format: { type: "json_object" },
        input: [{ role: "user", content }],
      });
      if (!res.ok) throw new Error("The review model is unavailable.");
      const body = (await res.json()) as { output_text?: string };
      const parsed = JSON.parse(body.output_text ?? "{}") as Record<string, unknown>;
      // The wrong-world check is deterministic: the judge CLASSIFIES what it
      // sees — an easier ask than remembering to fail — and code compares. A
      // take whose medium differs from the approved opening frame's never
      // passes, whatever the holistic `ok` said (a 3D-CGI take of a 2D
      // production has slipped a judge's overall judgment before).
      const MEDIA = ["hand-drawn-2d", "3d-cgi", "live-action", "stop-motion"];
      const medium = typeof parsed.medium === "string" ? parsed.medium.trim() : "";
      const frameMedium = typeof parsed.frameMedium === "string" ? parsed.frameMedium.trim() : "";
      if (keyframeShown && MEDIA.includes(medium) && MEDIA.includes(frameMedium) && medium !== frameMedium) {
        return {
          ok: false,
          offModel: true,
          note: `render as ${frameMedium} matching the opening frame's artwork, not ${medium}`,
        };
      }
      const ok = parsed.ok !== false;
      const note = typeof parsed.note === "string" ? parsed.note.trim() : "";
      const offModel = !ok && parsed.offModel === true;
      const rawFrom = typeof parsed.fromSec === "number" && Number.isFinite(parsed.fromSec) ? parsed.fromSec : 0;
      const fromSec = Math.min(Math.max(0, rawFrom), Math.max(0, clipSec - input.slotSec));
      // Identity gets its own focused comparison — one sheet, a few frames,
      // one question. Buried inside the multi-rule review above, a wrong
      // design has slipped a holistic "ok" before; a dedicated call is the
      // same judge doing a far easier task.
      if (ok && input.castSheets?.length) {
        for (const sheet of input.castSheets) {
          const img = await sheetImage(sheet.mediaId);
          if (!img) continue;
          // The judge must know the plan: a wardrobe the shot itself calls
          // for (a uniform, swimwear) is not identity drift.
          const idContent: Record<string, unknown>[] = [
            {
              text: `The shot's plan (attire it names overrides the sheet's): ${
                input.action || "(none written)"
              }
The canonical design sheet for "${sheet.name}":`,
            },
            { type: "input_image", dataBase64: img.data, mimeType: img.mimeType },
          ];
          const mid = frames.filter((_, i) => i % 2 === 1).slice(0, 3);
          for (const f of mid.length ? mid : frames.slice(0, 3)) {
            const fi = splitDataUrl(f.image);
            if (!fi) continue;
            idContent.push({ text: `Shot frame at ${f.at.toFixed(1)}s:` });
            idContent.push({ type: "input_image", dataBase64: fi.data, mimeType: fi.mimeType });
          }
          const idRes = await hostedPost("/api/inference/responses", {
            donkeyProvider: "gemini",
            model: geminiModelRoleNames.review,
            instructions: IDENTITY_INSTRUCTIONS,
            response_format: { type: "json_object" },
            input: [{ role: "user", content: idContent }],
          });
          if (!idRes.ok) break; // best-effort: the main verdict stands
          const idBody = (await idRes.json()) as { output_text?: string };
          const idParsed = JSON.parse(idBody.output_text ?? "{}") as Record<string, unknown>;
          if (idParsed.sameDesign === false) {
            const drift =
              typeof idParsed.drift === "string" && idParsed.drift.trim()
                ? idParsed.drift.trim()
                : `the character does not match the design sheet for ${sheet.name}`;
            return { ok: false, offModel: true, note: drift };
          }
        }
      }
      return {
        ok,
        ...(note ? { note } : {}),
        ...(offModel ? { offModel } : {}),
        ...(fromSec > 0 ? { fromSec } : {}),
      };
    },
  };
}
