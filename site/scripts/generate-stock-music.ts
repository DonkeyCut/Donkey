// Generates the bundled Cut stock-music catalog with the same Lyria renderer the
// app uses, uploads the files to the media bucket, and writes the typed
// manifest the editor imports. The bytes live in R2 and a local cache, never in
// git; people hear them from media.donkeycut.com (the media Worker treats
// stock/music/ as public). Idempotent: an id already in the bucket is skipped,
// so re-running fills gaps or picks up new catalog entries only.
//
//   cd site && ./node_modules/.bin/bun scripts/generate-stock-music.ts
//
// Needs GOOGLE_APPLICATION_CREDENTIALS_JSON and R2_ACCOUNT_ID /
// R2_ACCESS_KEY_ID / R2_SECRET_ACCESS_KEY (bun auto-loads site/.env) and
// ffmpeg on PATH (for duration + waveform peaks). Each bed renders as a ~30s
// mp3. Lyria takes no response_format and rejects background interactions, so
// the create call blocks until the clip is ready; it also filters prompts
// strictly, so a blocked prompt is logged and skipped (not retried — it would
// block every time).

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { GetObjectCommand, HeadObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { GoogleGenAI } from "@google/genai";
import { JWT } from "google-auth-library";

import { CUT_MEDIA_ORIGIN } from "../src/cut/lib/hosts";
import { geminiMusicModels } from "../src/lib/inference/gemini-models";
import type { StockMusicCategory } from "../src/cut/lib/stock";

interface CatalogItem {
  id: string;
  category: StockMusicCategory;
  prompt: string;
  tags: string[];
}

const MODEL = geminiMusicModels.clip;
const BUCKET = "donkey-cut";
const KEY_PREFIX = "stock/music/";
const CACHE_DIR = path.join(import.meta.dirname, "..", ".cache", "stock-music");
const MANIFEST = path.join(import.meta.dirname, "..", "src", "cut", "lib", "stockMusicManifest.ts");
// Clips render in ~10-15s each; a small fan-out keeps well under quota.
const CONCURRENCY = 3;
const POLL_MS = 4_000;
const PEAKS = 56;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Prompts describe instruments, mood, and tempo in plain words — Lyria blocks
// genre labels and artist-adjacent phrasing, so none of those appear here. The
// Songs are described so the model writes and sings its own lyrics; every other
// entry ends "instrumental background music" so no vocals sneak in.
const CATALOG: CatalogItem[] = [
  // Songs — full tracks with sung vocals (the model writes the lyrics).
  { id: "songs-sunny-folk", category: "Songs", prompt: "A warm cheerful acoustic folk song with guitar and harmonica and gentle sung vocals, about a bright sunny morning walk.", tags: ["song", "vocals", "folk", "acoustic", "guitar", "cheerful"] },
  { id: "songs-indie-dream", category: "Songs", prompt: "An upbeat indie pop song with bright jangly guitars, a catchy chorus, and warm sung vocals about chasing a dream.", tags: ["song", "vocals", "indie", "pop", "upbeat", "guitar"] },
  { id: "songs-soft-ballad", category: "Songs", prompt: "A tender slow ballad with piano, soft strings, and heartfelt sung vocals about missing someone far away.", tags: ["song", "vocals", "ballad", "piano", "emotional", "slow"] },
  { id: "songs-summer-night", category: "Songs", prompt: "An energetic feel-good song with bright synths, handclaps, and confident sung vocals about a fun night out with friends.", tags: ["song", "vocals", "upbeat", "synth", "energetic", "fun"] },
  { id: "songs-open-road", category: "Songs", prompt: "A laid-back country-style song with acoustic guitar, light drums, and warm sung vocals about a long drive down an open road.", tags: ["song", "vocals", "country", "acoustic", "guitar", "laidback"] },
  { id: "songs-city-lights", category: "Songs", prompt: "A smooth mellow song with soft electric piano, a gentle groove, and silky sung vocals about a quiet late-night city walk.", tags: ["song", "vocals", "smooth", "mellow", "keys", "night"] },
  { id: "songs-new-morning", category: "Songs", prompt: "An uplifting anthem with piano, warm layered harmonies, and joyful sung vocals about hope and new beginnings.", tags: ["song", "vocals", "uplifting", "anthem", "piano", "hopeful"] },
  { id: "songs-quiet-evening", category: "Songs", prompt: "A tender acoustic love song with fingerpicked guitar and soft sung vocals about a calm quiet evening together.", tags: ["song", "vocals", "love", "acoustic", "guitar", "tender"] },

  // Cinematic
  { id: "cinematic-rising-strings", category: "Cinematic", prompt: "Sweeping orchestral strings building to a triumphant swell, epic and emotional, instrumental film score.", tags: ["orchestral", "strings", "epic", "emotional", "trailer", "dramatic"] },
  { id: "cinematic-tension", category: "Cinematic", prompt: "Tense low strings and a slow pulsing drum, dark and suspenseful, instrumental film score.", tags: ["tension", "suspense", "dark", "strings", "drums", "dramatic"] },
  { id: "cinematic-hopeful-piano", category: "Cinematic", prompt: "Hopeful piano melody with warm strings underneath, uplifting and inspiring, instrumental film score.", tags: ["piano", "strings", "hopeful", "uplifting", "inspiring", "warm"] },
  { id: "cinematic-heroic-brass", category: "Cinematic", prompt: "Powerful cinematic drums and bold brass, heroic and grand, instrumental trailer music.", tags: ["brass", "drums", "heroic", "epic", "grand", "trailer"] },
  { id: "cinematic-melancholy-cello", category: "Cinematic", prompt: "Slow melancholic cello and soft piano, reflective and emotional, instrumental film score.", tags: ["cello", "piano", "melancholy", "sad", "reflective", "emotional"] },

  // Ambient
  { id: "ambient-warm-pad", category: "Ambient", prompt: "Warm soft synth pads drifting slowly, calm and spacious, instrumental ambient background music.", tags: ["pads", "warm", "calm", "spacious", "drone", "soft"] },
  { id: "ambient-ethereal", category: "Ambient", prompt: "Ethereal shimmering textures and gentle drones, dreamy and weightless, instrumental ambient background music.", tags: ["ethereal", "dreamy", "textures", "drone", "shimmer", "airy"] },
  { id: "ambient-deep-space", category: "Ambient", prompt: "Deep evolving drones and distant tones, vast and meditative, instrumental ambient background music.", tags: ["deep", "drone", "meditative", "vast", "space", "calm"] },
  { id: "ambient-soothing", category: "Ambient", prompt: "Soft gentle pads with a peaceful mood, soothing and quiet, instrumental ambient background music.", tags: ["soothing", "peaceful", "quiet", "soft", "pads", "calm"] },

  // Acoustic
  { id: "acoustic-guitar-calm", category: "Acoustic", prompt: "Gentle fingerpicked acoustic guitar, calm and peaceful, instrumental background music.", tags: ["acoustic", "guitar", "calm", "peaceful", "fingerpicked", "gentle"] },
  { id: "acoustic-folk-warm", category: "Acoustic", prompt: "Warm acoustic guitar and soft strings, cozy and heartfelt, instrumental background music.", tags: ["acoustic", "guitar", "strings", "warm", "cozy", "folk"] },
  { id: "acoustic-sunny-morning", category: "Acoustic", prompt: "Bright acoustic guitar with a light cheerful feel, fresh and sunny, instrumental background music.", tags: ["acoustic", "guitar", "bright", "cheerful", "sunny", "fresh"] },
  { id: "acoustic-ukulele-happy", category: "Acoustic", prompt: "Playful ukulele and light hand percussion, happy and carefree, instrumental background music.", tags: ["ukulele", "percussion", "happy", "carefree", "playful", "light"] },

  // Electronic
  { id: "electronic-driving-synth", category: "Electronic", prompt: "Driving synth arpeggios over a steady beat, energetic and modern, instrumental background music.", tags: ["synth", "arpeggio", "energetic", "modern", "beat", "driving"] },
  { id: "electronic-glow", category: "Electronic", prompt: "Glowing synth melody with a smooth pulse, bright and futuristic, instrumental background music.", tags: ["synth", "bright", "futuristic", "glow", "smooth", "pulse"] },
  { id: "electronic-downtempo", category: "Electronic", prompt: "Smooth downtempo beat with mellow synths, relaxed and cool, instrumental background music.", tags: ["downtempo", "synth", "relaxed", "cool", "beat", "mellow"] },
  { id: "electronic-retro-wave", category: "Electronic", prompt: "Dreamy retro synths with a slow steady groove, nostalgic and atmospheric, instrumental background music.", tags: ["synth", "retro", "nostalgic", "atmospheric", "dreamy", "groove"] },

  // Upbeat
  { id: "upbeat-claps-pop", category: "Upbeat", prompt: "Upbeat groove with claps and bright synths, happy and energetic, instrumental background music.", tags: ["upbeat", "claps", "happy", "energetic", "bright", "synth"] },
  { id: "upbeat-funky-bass", category: "Upbeat", prompt: "Funky bass and rhythmic guitar, groovy and fun, instrumental background music.", tags: ["funk", "bass", "guitar", "groovy", "fun", "rhythmic"] },
  { id: "upbeat-summer", category: "Upbeat", prompt: "Bright summery melody with a bouncy rhythm, cheerful and lively, instrumental background music.", tags: ["summer", "bright", "bouncy", "cheerful", "lively", "happy"] },
  { id: "upbeat-motivational", category: "Upbeat", prompt: "Energetic beat with punchy drums and bright chords, confident and driving, instrumental background music.", tags: ["motivational", "drums", "confident", "driving", "energetic", "bright"] },

  // Chill
  { id: "chill-mellow-keys", category: "Chill", prompt: "Mellow electric piano over a soft laid-back beat, relaxed and smooth, instrumental background music.", tags: ["chill", "electric piano", "relaxed", "smooth", "laidback", "beat"] },
  { id: "chill-lounge", category: "Chill", prompt: "Smooth lounge groove with soft keys and light percussion, easy and calm, instrumental background music.", tags: ["lounge", "keys", "percussion", "easy", "calm", "smooth"] },
  { id: "chill-sunset", category: "Chill", prompt: "Warm mellow chords with a gentle slow groove, dreamy and relaxed, instrumental background music.", tags: ["chill", "warm", "dreamy", "relaxed", "groove", "mellow"] },
  { id: "chill-study", category: "Chill", prompt: "Soft calm keys and a light steady beat, focused and easygoing, instrumental background music.", tags: ["study", "focus", "calm", "keys", "easygoing", "soft"] },

  // Corporate
  { id: "corporate-clean", category: "Corporate", prompt: "Clean bright piano and light strings over a steady beat, professional and positive, instrumental background music.", tags: ["corporate", "piano", "strings", "professional", "positive", "clean"] },
  { id: "corporate-tech", category: "Corporate", prompt: "Modern minimal synths and a subtle beat, sleek and forward-looking, instrumental background music.", tags: ["corporate", "tech", "synth", "sleek", "modern", "minimal"] },
  { id: "corporate-inspiring", category: "Corporate", prompt: "Uplifting piano and warm strings building gently, optimistic and inspiring, instrumental background music.", tags: ["corporate", "piano", "strings", "inspiring", "optimistic", "uplifting"] },
  { id: "corporate-confident", category: "Corporate", prompt: "Confident steady rhythm with bright plucks and soft pads, professional and motivating, instrumental background music.", tags: ["corporate", "confident", "plucks", "pads", "professional", "motivating"] },

  // Piano
  { id: "piano-gentle-solo", category: "Piano", prompt: "Gentle solo piano, tender and reflective, instrumental background music.", tags: ["piano", "solo", "gentle", "tender", "reflective", "calm"] },
  { id: "piano-emotional", category: "Piano", prompt: "Expressive emotional piano with soft dynamics, moving and heartfelt, instrumental background music.", tags: ["piano", "emotional", "expressive", "heartfelt", "moving", "soft"] },
  { id: "piano-bright-flowing", category: "Piano", prompt: "Bright flowing piano melody, hopeful and warm, instrumental background music.", tags: ["piano", "bright", "flowing", "hopeful", "warm", "melodic"] },
  { id: "piano-quiet-nocturne", category: "Piano", prompt: "Slow contemplative piano in a quiet mood, calm and intimate, instrumental background music.", tags: ["piano", "slow", "contemplative", "quiet", "calm", "intimate"] },
];

function makeClient(): { client: GoogleGenAI; authClient: JWT; project: string } {
  const raw = process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON?.trim();
  if (!raw) throw new Error("GOOGLE_APPLICATION_CREDENTIALS_JSON is not set (run from site/ so bun loads .env).");
  const creds = JSON.parse(raw) as { project_id?: string; client_email?: string; private_key?: string; private_key_id?: string };
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
  return { client, authClient, project: creds.project_id };
}

function makeR2(): S3Client {
  const accountId = process.env.R2_ACCOUNT_ID;
  const accessKeyId = process.env.R2_ACCESS_KEY_ID;
  const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY;
  if (!accountId || !accessKeyId || !secretAccessKey) throw new Error("R2_ACCOUNT_ID / R2_ACCESS_KEY_ID / R2_SECRET_ACCESS_KEY are not set.");
  return new S3Client({
    region: "auto",
    endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
    credentials: { accessKeyId, secretAccessKey },
  });
}

const keyFor = (id: string) => `${KEY_PREFIX}${id}.mp3`;
const cachePath = (id: string) => path.join(CACHE_DIR, `${id}.mp3`);
const fileUrl = (id: string) => `${CUT_MEDIA_ORIGIN}/${keyFor(id)}`;

class BlockedError extends Error {}

/** Renders one bed and resolves to its mp3 bytes. Lyria rejects background, so
 * create blocks to completion; a content block throws BlockedError (never
 * retried). */
async function generateOne(client: GoogleGenAI, authClient: JWT, item: CatalogItem): Promise<Buffer> {
  let ix;
  try {
    ix = await client.interactions.create({ model: MODEL, input: item.prompt });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (/block|policy|safety/i.test(msg)) throw new BlockedError(msg);
    throw e;
  }
  const t0 = Date.now();
  while (ix.status === "in_progress" || ix.status === "requires_action") {
    if (Date.now() - t0 > 180_000) throw new Error("music generation timed out");
    await sleep(POLL_MS);
    ix = await client.interactions.get(ix.id);
  }
  if (ix.status !== "completed") {
    const step = [...(ix.steps ?? [])].reverse().find((st) => (st as { error?: unknown }).error);
    const message = (step as { error?: { message?: string } } | undefined)?.error?.message;
    if (message && /block|policy|safety/i.test(message)) throw new BlockedError(message);
    throw new Error(message ?? `music generation ${ix.status}`);
  }
  const audio = ix.output_audio;
  if (audio?.data) return Buffer.from(audio.data, "base64");
  if (audio?.uri) {
    const token = await authClient.getAccessToken();
    const res = await fetch(audio.uri, { headers: { Authorization: `Bearer ${token.token}` } });
    if (!res.ok) throw new Error(`could not download the rendered music (${res.status})`);
    return Buffer.from(await res.arrayBuffer());
  }
  throw new Error("no audio in response");
}

/** The rendered mp3's real length via ffprobe. */
function probeDuration(id: string): number {
  const proc = spawnSync("ffprobe", [
    "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0",
    cachePath(id),
  ]);
  const sec = Number.parseFloat(proc.stdout?.toString().trim() ?? "");
  if (proc.status !== 0 || !Number.isFinite(sec) || sec <= 0) {
    throw new Error(`ffprobe could not read ${id}.mp3's duration`);
  }
  return Math.round(sec * 10) / 10;
}

/** Normalized 0..1 waveform peaks for the browse card: decode to mono PCM with
 * ffmpeg, take the max magnitude per bucket, scale so the loudest bar fills. */
function computePeaks(id: string): number[] {
  const proc = spawnSync(
    "ffmpeg",
    ["-v", "error", "-i", cachePath(id), "-f", "s16le", "-ac", "1", "-ar", "8000", "-"],
    { maxBuffer: 256 * 1024 * 1024 }
  );
  const buf = proc.stdout;
  if (proc.status !== 0 || !buf || buf.length < 2) throw new Error(`ffmpeg could not decode ${id}.mp3`);
  const samples = new Int16Array(buf.buffer, buf.byteOffset, Math.floor(buf.length / 2));
  const bucket = Math.max(1, Math.floor(samples.length / PEAKS));
  const raw: number[] = [];
  for (let i = 0; i < PEAKS; i++) {
    let m = 0;
    for (let j = i * bucket; j < Math.min(samples.length, (i + 1) * bucket); j++) {
      const a = Math.abs(samples[j]);
      if (a > m) m = a;
    }
    raw.push(m / 32768);
  }
  const max = Math.max(...raw, 0.0001);
  return raw.map((p) => Math.round((p / max) * 100) / 100);
}

async function upload(r2: S3Client, id: string): Promise<void> {
  await r2.send(
    new PutObjectCommand({
      Bucket: BUCKET,
      Key: keyFor(id),
      Body: await readFile(cachePath(id)),
      ContentType: "audio/mpeg",
      CacheControl: "public, max-age=31536000, immutable",
    })
  );
}

/** True when the bucket already holds this id; pulls it into the cache when
 * the local copy is missing so its peaks can be read. */
async function adopt(r2: S3Client, id: string): Promise<boolean> {
  if (existsSync(cachePath(id))) return true;
  try {
    await r2.send(new HeadObjectCommand({ Bucket: BUCKET, Key: keyFor(id) }));
  } catch {
    return false;
  }
  const res = await r2.send(new GetObjectCommand({ Bucket: BUCKET, Key: keyFor(id) }));
  const bytes = await res.Body?.transformToByteArray();
  if (!bytes) return false;
  await mkdir(CACHE_DIR, { recursive: true });
  await writeFile(cachePath(id), Buffer.from(bytes));
  return true;
}

async function writeManifest(results: Map<string, { duration: number; peaks: number[] }>) {
  const entries = CATALOG.filter((c) => results.has(c.id)).map((c) => ({
    id: c.id,
    category: c.category,
    prompt: c.prompt,
    tags: c.tags,
    file: fileUrl(c.id),
    duration: results.get(c.id)!.duration,
    peaks: results.get(c.id)!.peaks,
  }));
  const body = `// Generated by scripts/generate-stock-music.ts — do not edit by hand.
import type { StockMusic } from "./stock";

export const STOCK_MUSIC: StockMusic[] = [
${entries.map((e) => `  ${JSON.stringify(e)},`).join("\n")}
];
`;
  await writeFile(MANIFEST, body);
}

async function main() {
  const r2 = makeR2();
  await mkdir(CACHE_DIR, { recursive: true });

  const results = new Map<string, { duration: number; peaks: number[] }>();
  // Adopt every clip the bucket or the cache already holds so its manifest row
  // survives; a clip on disk that the bucket lacks is uploaded now.
  for (const c of CATALOG) {
    if (!(await adopt(r2, c.id))) continue;
    try {
      results.set(c.id, { duration: probeDuration(c.id), peaks: computePeaks(c.id) });
    } catch (e) {
      await unlink(cachePath(c.id));
      console.error(`✗ reprobe ${c.id}: ${e instanceof Error ? e.message : e}`);
      continue;
    }
    try {
      await r2.send(new HeadObjectCommand({ Bucket: BUCKET, Key: keyFor(c.id) }));
    } catch {
      await upload(r2, c.id);
      console.log(`↑ ${c.id}`);
    }
  }
  const todo = CATALOG.filter((c) => !results.has(c.id));
  await writeManifest(results);
  if (todo.length === 0) {
    console.log(`manifest: ${results.size}/${CATALOG.length} beds, nothing to generate`);
    return;
  }
  const { client, authClient, project } = makeClient();
  console.log(`model=${MODEL} project=${project} existing=${results.size} generating=${todo.length}`);

  let failed = 0;
  let blocked = 0;
  const queue = [...todo];
  const worker = async () => {
    for (let item = queue.shift(); item; item = queue.shift()) {
      for (let attempt = 1; ; attempt++) {
        try {
          const mp3 = await generateOne(client, authClient, item);
          await writeFile(cachePath(item.id), mp3);
          results.set(item.id, { duration: probeDuration(item.id), peaks: computePeaks(item.id) });
          await upload(r2, item.id);
          await writeManifest(results); // incremental: partial progress is usable
          console.log(`✓ ${item.id} (${results.get(item.id)!.duration}s)`);
          break;
        } catch (e) {
          if (e instanceof BlockedError) {
            blocked++;
            console.error(`⊘ ${item.id} blocked: ${e.message}`);
            break;
          }
          if (attempt >= 2) {
            failed++;
            console.error(`✗ ${item.id}: ${e instanceof Error ? e.message : e}`);
            break;
          }
          console.warn(`retrying ${item.id}…`);
        }
      }
    }
  };
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));

  await writeManifest(results);
  console.log(`manifest: ${results.size}/${CATALOG.length} beds${blocked ? `, ${blocked} blocked` : ""}${failed ? `, ${failed} failed` : ""}`);
  if (failed) process.exitCode = 1;
}

await main();
