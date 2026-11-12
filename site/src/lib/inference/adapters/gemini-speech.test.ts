import { describe, expect, test } from "bun:test";
import type { GenerateContentParameters } from "@google/genai";
import { createGeminiSpeechAssetProvider } from "./gemini-speech";
import type { AssetGenerationProviderRequest } from "@/lib/inference/providers";

const SAMPLE_RATE = 24_000;
const SAMPLES = [0, 1000, -1000, 32767];

/** A 16-bit mono WAV holding `samples`, the shape the speech model answers
 * with; `channels` and `bits` build the formats it never should. */
function wavBytes(rate: number, samples = SAMPLES, channels = 1, bits = 16): Buffer {
  const pcm = Buffer.alloc(samples.length * 2);
  samples.forEach((v, i) => pcm.writeInt16LE(v, i * 2));
  const header = Buffer.alloc(44);
  header.write("RIFF", 0, "latin1");
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write("WAVE", 8, "latin1");
  header.write("fmt ", 12, "latin1");
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(rate, 24);
  header.writeUInt32LE(rate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(bits, 34);
  header.write("data", 36, "latin1");
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

// One provider over a fake client that records the request and answers with
// the given audio part.
function speechProvider(...answers: { data: string; mimeType: string }[]) {
  const sent: GenerateContentParameters[] = [];
  const provider = createGeminiSpeechAssetProvider(
    {
      GOOGLE_APPLICATION_CREDENTIALS_JSON: JSON.stringify({
        project_id: "p",
        client_email: "svc@example.invalid",
        private_key: "-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----\n",
      }),
    },
    () =>
      ({
        models: {
          generateContent: async (params: GenerateContentParameters) => {
            sent.push(params);
            const inlineData = answers[Math.min(sent.length, answers.length) - 1];
            return { candidates: [{ content: { parts: [{ inlineData }] }, finishReason: "STOP" }] };
          },
        },
      }) as never,
  );
  return { provider, sent };
}

const speak = (parameters: Record<string, unknown>) =>
  ({
    generationId: "g1",
    request: { kind: "speech", prompt: "We made it.", inputs: { voice: "Kore" }, parameters },
  }) as unknown as AssetGenerationProviderRequest;

describe("Gemini speech", () => {
  test("a WAV answer reaches callers as bare PCM at the file's rate", async () => {
    const wav = wavBytes(SAMPLE_RATE);
    const { provider } = speechProvider({ data: wav.toString("base64"), mimeType: "audio/wav" });

    const result = await provider.generateAsset!(speak({}));

    const out = result.outputs[0];
    expect(out.contentType).toBe(`audio/L16;codec=pcm;rate=${SAMPLE_RATE}`);
    expect(Buffer.from(out.dataBase64!, "base64").equals(wav.subarray(44))).toBe(true);
    expect(out.byteCount).toBe(SAMPLES.length * 2);
  });

  test("the style rides the part's speech metadata and the text stays verbatim", async () => {
    const { provider, sent } = speechProvider({ data: wavBytes(SAMPLE_RATE).toString("base64"), mimeType: "audio/wav" });

    await provider.generateAsset!(speak({ style: "a spooky whisper" }));
    await provider.generateAsset!(speak({}));

    const parts = sent.map((p) => (p.contents as { parts: Record<string, unknown>[] }[])[0].parts[0]);
    expect(parts[0]).toEqual({ text: "We made it.", speechMetadata: { style: "a spooky whisper" } });
    expect(parts[1]).toEqual({ text: "We made it." });
  });

  test("a WAV with no samples counts as no audio, so the call is resent", async () => {
    const empty = { data: wavBytes(SAMPLE_RATE, []).toString("base64"), mimeType: "audio/wav" };
    const full = { data: wavBytes(SAMPLE_RATE).toString("base64"), mimeType: "audio/wav" };
    const { provider, sent } = speechProvider(empty, full);

    const result = await provider.generateAsset!(speak({}));

    expect(sent.length).toBe(2);
    expect(result.outputs[0].byteCount).toBe(SAMPLES.length * 2);
  });

  test("a WAV that is not 16-bit mono fails instead of playing as noise", async () => {
    const stereo = { data: wavBytes(SAMPLE_RATE, SAMPLES, 2).toString("base64"), mimeType: "audio/wav" };
    const { provider } = speechProvider(stereo);

    await expect(provider.generateAsset!(speak({}))).rejects.toThrow("16-bit mono");
  });
});
