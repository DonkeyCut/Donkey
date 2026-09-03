// Renders the hosted voice-persona assets the Cut voice picker shows: one
// square portrait and one spoken sample clip per prebuilt speech voice. Both are
// produced with the same Vertex models the app uses — gemini-3.1-flash-image for
// the portrait, the Gemini TTS model for the sample — and written into
// public/cut/voices as <id>.webp and <id>.mp3 (lowercased ids, matching
// voicePortraitUrl / voiceSampleUrl). Idempotent: a voice whose portrait and
// sample already exist is skipped, so re-running fills gaps or picks up voices
// added to the catalog only.
//
//   cd site && ./node_modules/.bin/bun scripts/generate-voices.ts
//
// Needs GOOGLE_APPLICATION_CREDENTIALS_JSON (bun auto-loads site/.env) and
// ffmpeg on PATH (raw PCM -> MP3). Force a re-render with `--force`.

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { GoogleGenAI, Modality } from "@google/genai";
import { JWT } from "google-auth-library";
import sharp from "sharp";

import { geminiModels, geminiTtsModels } from "../src/lib/inference/gemini-models";
import { SPEECH_VOICES, VOICE_SAMPLE_TEXT } from "../src/cut/lib/voices";

const IMAGE_MODEL = geminiModels.flashImage;
const TTS_MODEL = geminiTtsModels.flash;
const OUT_DIR = path.join(import.meta.dirname, "..", "public", "cut", "voices");
const PORTRAIT_EDGE = 512;
const CONCURRENCY = 3;
const FORCE = process.argv.includes("--force");

// Gemini TTS returns raw little-endian 16-bit mono PCM (audio/L16), 24 kHz default.
const PCM_SAMPLE_RATE = 24_000;

/** Per-voice portrait subject. Kept beside — not inside — the shared catalog so
 * the art direction stays out of the client bundle. One diverse persona per
 * voice, matched loosely to its style word; the wrapper adds the framing. */
const PORTRAIT_SUBJECT: Record<string, string> = {
  Zephyr: "a bright, cheerful woman in her late 20s with short wavy auburn hair and light freckles",
  Puck: "an upbeat young man in his mid-20s with tousled dark hair and a playful half-smile",
  Charon: "a composed man in his 40s with a trimmed salt-and-pepper beard and glasses, thoughtful",
  Kore: "a confident woman in her 30s with sleek black hair pulled back and a calm, resolute look",
  Fenrir: "an energetic young woman in her 20s with curly hair and animated, wide bright eyes",
  Leda: "a youthful woman in her early 20s with an open, fresh face and shoulder-length light-brown hair",
  Orus: "a steady man in his late 30s with a strong jaw and short cropped hair, quietly assertive",
  Aoede: "a relaxed woman in her late 20s with loose beachy waves and a soft, easy smile",
  Callirrhoe: "a laid-back woman in her 30s with warm brown skin and natural curls, gentle and unhurried",
  Autonoe: "a radiant woman in her late 20s with a wide bright smile and neat dark hair",
  Enceladus: "a soft-spoken man in his 30s with fair skin, light stubble, and a gentle expression",
  Iapetus: "a clear-eyed man in his early 30s with clean-cut short hair and an attentive look",
  Umbriel: "an easy-going man in his 40s with a relaxed smile and slightly greying temples",
  Algieba: "a poised man in his 30s with dark skin and a neat short fade, smooth and self-assured",
  Despina: "a poised woman in her 30s with straight dark hair and a serene, elegant expression",
  Erinome: "a crisp, professional woman in her late 20s with a tidy bob and bright attentive eyes",
  Algenib: "a rugged man in his 50s with a weathered face, grey stubble, and deep-set eyes",
  Rasalgethi: "a knowledgeable man in his 40s with glasses and neat dark hair, warm and precise",
  Laomedeia: "an upbeat woman in her mid-20s with a lively grin and a bouncy ponytail",
  Achernar: "a gentle woman in her 30s with soft features, pale skin, and a quiet, kind expression",
  Alnilam: "a firm, dependable man in his 40s with short greying hair and a level gaze",
  Schedar: "a calm, even-tempered man in his 40s with a warm medium skin tone and neat short hair",
  Gacrux: "a mature woman in her 50s with elegant silver hair and a warm, wise smile",
  Pulcherrima: "a bold woman in her early 30s with a confident chin-up pose and sleek hair",
  Achird: "a friendly man in his 30s with a warm, approachable smile and a light beard",
  Zubenelgenubi: "a casual young man in his late 20s with messy hair and a relaxed, offhand smile",
  Vindemiatrix: "a gentle woman in her 50s with kind eyes, glasses, and soft silver-grey hair",
  Sadachbia: "a lively young woman in her mid-20s with an animated smile and warm energy",
  Sadaltager: "a knowledgeable man in his 40s with a scholarly look, glasses, and neat dark hair",
  Sulafat: "a warm woman in her late 30s with golden-brown skin, soft curls, and an inviting smile",
};

// Muted, editorial studio backdrop tones — assigned per voice by catalog
// position so each persona gets a distinct wall color and re-runs stay stable.
const BACKDROPS = [
  "soft terracotta",
  "muted sage green",
  "dusty slate blue",
  "warm blush pink",
  "muted mustard ochre",
  "deep teal",
  "soft lavender grey",
  "warm caramel",
  "muted plum",
  "soft coral",
  "cool olive green",
  "warm sand beige",
  "dusty rose",
  "steel blue grey",
  "soft amber",
  "muted forest green",
];
const backdropFor = (id: string) =>
  BACKDROPS[Math.max(0, SPEECH_VOICES.findIndex((v) => v.id === id)) % BACKDROPS.length];

const portraitPrompt = (subject: string, backdrop: string) =>
  `Editorial studio headshot portrait of ${subject}. Soft diffused key light, plain ${backdrop} studio backdrop softly lit and slightly out of focus, shallow depth of field, sharp focus on the eyes, natural skin texture, relaxed friendly expression, looking toward the camera, shoulders-up and centered in a square frame. Photorealistic. No text, no watermark, no logo, no props, no border.`;

function makeClient(): { client: GoogleGenAI; project: string } {
  const raw = process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON?.trim();
  if (!raw) throw new Error("GOOGLE_APPLICATION_CREDENTIALS_JSON is not set (run from site/ so bun loads .env).");
  const creds = JSON.parse(raw) as {
    project_id?: string;
    client_email?: string;
    private_key?: string;
    private_key_id?: string;
  };
  if (!creds.project_id || !creds.client_email || !creds.private_key) {
    throw new Error("Service account JSON is missing project_id/client_email/private_key.");
  }
  const authClient = new JWT({
    email: creds.client_email,
    key: creds.private_key,
    keyId: creds.private_key_id,
    scopes: ["https://www.googleapis.com/auth/cloud-platform"],
  });
  const client = new GoogleGenAI({
    vertexai: true,
    location: "global",
    project: creds.project_id,
    googleAuthOptions: { authClient },
  });
  return { client, project: creds.project_id };
}

const portraitPath = (id: string) => path.join(OUT_DIR, `${id.toLowerCase()}.webp`);
const samplePath = (id: string) => path.join(OUT_DIR, `${id.toLowerCase()}.mp3`);
const hasAssets = (id: string) => existsSync(portraitPath(id)) && existsSync(samplePath(id));

/** One portrait: generate a square image, crop-cover to the tile size, write WebP. */
async function renderPortrait(client: GoogleGenAI, id: string): Promise<void> {
  const subject = PORTRAIT_SUBJECT[id] ?? "a friendly person with a calm, approachable expression";
  const contents = [{ role: "user", parts: [{ text: portraitPrompt(subject, backdropFor(id)) }] }];
  let response;
  try {
    response = await client.models.generateContent({
      model: IMAGE_MODEL,
      contents,
      config: {
        responseModalities: [Modality.IMAGE, Modality.TEXT],
        imageConfig: { aspectRatio: "1:1" },
      } as Record<string, unknown>,
    });
  } catch {
    response = await client.models.generateContent({
      model: IMAGE_MODEL,
      contents,
      config: { responseModalities: [Modality.IMAGE, Modality.TEXT] },
    });
  }
  const parts = response.candidates?.[0]?.content?.parts ?? [];
  const data = parts.find((p) => p.inlineData?.data)?.inlineData?.data;
  if (!data) throw new Error("no image in response");
  const webp = await sharp(Buffer.from(data, "base64"))
    .resize(PORTRAIT_EDGE, PORTRAIT_EDGE, { fit: "cover", position: "attention" })
    .webp({ quality: 82, smartSubsample: true })
    .toBuffer();
  await writeFile(portraitPath(id), webp);
}

/** One sample: speak VOICE_SAMPLE_TEXT in this voice, then transcode the raw PCM to MP3. */
async function renderSample(client: GoogleGenAI, id: string): Promise<void> {
  let pcm: Buffer | null = null;
  let rate = PCM_SAMPLE_RATE;
  // The TTS model intermittently returns an empty candidate (no audio); a resend
  // usually clears it, so retry a few times before giving up.
  for (let attempt = 1; attempt <= 4 && !pcm; attempt += 1) {
    const response = await client.models.generateContent({
      model: TTS_MODEL,
      contents: [{ role: "user", parts: [{ text: VOICE_SAMPLE_TEXT }] }],
      config: {
        responseModalities: [Modality.AUDIO],
        speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: id } } },
      },
    });
    const inline = response.candidates?.[0]?.content?.parts?.find((p) => p.inlineData?.data)?.inlineData;
    if (inline?.data) {
      pcm = Buffer.from(inline.data, "base64");
      rate = Number(inline.mimeType?.match(/rate=(\d+)/)?.[1]) || PCM_SAMPLE_RATE;
    }
  }
  if (!pcm) throw new Error("no audio after retries");
  await pcmToMp3(pcm, rate, samplePath(id));
}

/** Pipe raw 16-bit mono PCM through ffmpeg to a VBR MP3. */
function pcmToMp3(pcm: Buffer, rate: number, out: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const ff = spawn("ffmpeg", [
      "-y", "-hide_banner", "-loglevel", "error",
      "-f", "s16le", "-ar", String(rate), "-ac", "1", "-i", "pipe:0",
      "-codec:a", "libmp3lame", "-q:a", "4", out,
    ]);
    let stderr = "";
    ff.stderr.on("data", (d) => (stderr += d));
    ff.on("error", reject);
    ff.on("close", (code) =>
      code === 0 ? resolve() : reject(new Error(`ffmpeg exited ${code}: ${stderr.trim()}`))
    );
    ff.stdin.write(pcm);
    ff.stdin.end();
  });
}

async function main() {
  const { client, project } = makeClient();
  await mkdir(OUT_DIR, { recursive: true });

  const todo = FORCE ? [...SPEECH_VOICES] : SPEECH_VOICES.filter((v) => !hasAssets(v.id));
  console.log(
    `image=${IMAGE_MODEL} tts=${TTS_MODEL} project=${project} generating=${todo.length}/${SPEECH_VOICES.length}`
  );

  let failed = 0;
  const queue = [...todo];
  const worker = async () => {
    for (let v = queue.shift(); v; v = queue.shift()) {
      try {
        if (FORCE || !existsSync(portraitPath(v.id))) await renderPortrait(client, v.id);
        if (FORCE || !existsSync(samplePath(v.id))) await renderSample(client, v.id);
        console.log(`✓ ${v.id} · ${v.style}`);
      } catch (e) {
        failed++;
        console.error(`✗ ${v.id}: ${e instanceof Error ? e.message : e}`);
      }
    }
  };
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));

  console.log(`done: ${todo.length - failed}/${todo.length} voices${failed ? `, ${failed} failed` : ""}`);
  if (failed) process.exitCode = 1;
}

await main();
