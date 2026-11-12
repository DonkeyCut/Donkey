import { expect, test } from "bun:test";
import type { GoogleGenAIOptions } from "@google/genai";
import { createGeminiMusicAssetProvider, type GeminiMusicClient } from "./gemini-music";

// Lyria answers in the response revision a call names. Unpinned, Vertex moved
// to a revision whose completed interaction carries no audio, and every music
// generation failed as empty; the adapter pins the revision it reads.

const ENV = {
  GOOGLE_APPLICATION_CREDENTIALS_JSON: JSON.stringify({
    project_id: "p",
    client_email: "svc@example.invalid",
    private_key: "-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----\n",
  }),
};

test("a music call names the response revision it reads its audio from", async () => {
  const seen: GoogleGenAIOptions[] = [];
  const client = {
    interactions: {
      create: async () => ({ id: "i", status: "completed", output_audio: { data: "AAAA", mime_type: "audio/mp3" } }),
    },
  } as unknown as GeminiMusicClient;
  const provider = createGeminiMusicAssetProvider(ENV, (options) => {
    seen.push(options);
    return client;
  });

  const result = await provider.generateAsset!({ generationId: "g", request: { kind: "music", prompt: "ukulele" } } as never);
  expect(result.status).toBe("completed");
  expect(seen[0]?.httpOptions?.headers?.["Api-Revision"]).toBe("2026-05-20");
});
