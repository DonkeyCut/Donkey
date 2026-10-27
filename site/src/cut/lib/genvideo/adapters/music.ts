"use client";

/**
 * The music bed over the hosted asset route (kind:"music"). It is intentionally
 * best-effort: with no configured music backend the route rejects and this
 * throws, which the orchestrator catches to assemble the cut with no bed. So a
 * deploy without ELEVENLABS_API_KEY still produces a video, just a silent-bed
 * one.
 */

import { bytesFromBase64 } from "../../bytes";
import { applyOwnership } from "../../generate";
import { hostedPost } from "../../hosted";
import { enrichAsset, importFileToProject } from "../../media";
import { useEditor } from "../../store";
import type { MusicRole } from "../capabilities";
import { UserError } from "../../userError";

export function makeMusicRole(projectId: string, chatId?: string): MusicRole {
  return {
    async compose(input) {
      const res = await hostedPost("/api/inference/assets", {
        kind: "music",
        prompt: input.mood,
        parameters: { durationSeconds: Math.max(1, Math.round(input.durationSec)) },
      });
      if (!res.ok) {
        throw new UserError("music_unavailable", "Music generation is unavailable.");
      }
      const gen = (await res.json()) as {
        status?: string;
        outputs?: { dataBase64?: string; url?: string; contentType?: string; filename?: string }[];
      };
      const out = gen.outputs?.find((o) => o.dataBase64) ?? gen.outputs?.find((o) => o.url);
      let file: File;
      if (out?.dataBase64) {
        file = new File([bytesFromBase64(out.dataBase64)], out.filename ?? "music.mp3", {
          type: out.contentType ?? "audio/mpeg",
        });
      } else if (out?.url) {
        const dl = await fetch(out.url);
        if (!dl.ok) {
          throw new UserError("music_bed_download_failed", "Could not download the music bed.");
        }
        file = new File([await dl.arrayBuffer()], "music.mp3", { type: out.contentType ?? "audio/mpeg" });
      } else {
        throw new UserError("music_output_missing", "The provider returned no music.");
      }
      const asset = await importFileToProject(projectId, file);
      if (!asset) {
        throw new UserError("music_bed_import_failed", "Could not import the music bed.");
      }
      asset.name = "Music bed";
      // Chat-owned from birth so the bed never surfaces in a panel; it's placed
      // on the soundtrack as part of the run. Only the run's own thread id: the
      // ambient chat context is whatever thread is open when this lands.
      applyOwnership(asset, chatId);
      // Only stock the store when this run's project is the one open — a
      // background run whose project the user has since switched away from must
      // never drop its media into whatever project is now on screen.
      if (useEditor.getState().projectId === projectId) {
        useEditor.getState().addAsset(asset);
        void enrichAsset(asset);
      }
      return asset.id;
    },
  };
}
