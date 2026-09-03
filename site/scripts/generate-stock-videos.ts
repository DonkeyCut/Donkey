// Generates the bundled Cut stock-video catalog with the same omni renderer
// the app uses, then writes the typed manifest the editor imports.
// Idempotent: items whose file already exists are skipped, so re-running fills
// gaps or picks up new catalog entries only.
//
//   cd site && ./node_modules/.bin/bun scripts/generate-stock-videos.ts
//
// Needs GOOGLE_APPLICATION_CREDENTIALS_JSON (bun auto-loads site/.env) and
// ffmpeg on PATH for the poster thumbs. Each clip renders at 720p, lands as an
// mp4 under public/cut-stock-video, and gets a first-frame WebP thumb the
// browse grid uses.
//
// After generation, every clip is tagged: a vision pass looks at the poster
// frame and extracts the searchable keywords (objects, animals, setting) the
// editor's search box matches. Tags already in the manifest are reused, so
// re-running only tags new or untagged clips.

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { GoogleGenAI } from "@google/genai";
import { JWT } from "google-auth-library";
import sharp from "sharp";

import { geminiModels, geminiOmniModels } from "../src/lib/inference/gemini-models";
import { characterPrompt, type StockVideoAspect, type StockVideoCategory } from "../src/cut/lib/stock";

interface CatalogItem {
  id: string;
  category: StockVideoCategory;
  aspect: StockVideoAspect;
  prompt: string;
  /** Characters only: the person description, written into the manifest so the
   * editor can compose new lines for the same persona. */
  persona?: string;
}

const MODEL = geminiOmniModels.flashVideo;
const TAG_MODEL = geminiModels.flash;
const OUT_DIR = path.join(import.meta.dirname, "..", "public", "cut-stock-video");
const MANIFEST = path.join(import.meta.dirname, "..", "src", "cut", "lib", "stockVideoManifest.ts");
// Renders take minutes each and quotas are tight; keep the fan-out small.
const CONCURRENCY = 2;
const POLL_MS = 10_000;
/** Longest thumb edge — the browse grid renders tiles well under this. */
const THUMB_EDGE = 512;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const clip = (subject: string) =>
  `Cinematic stock footage: ${subject} Smooth, steady camera motion, natural lighting, realistic color grading. No text, no watermarks, no logos.`;

const animeClip = (subject: string) =>
  `High-quality anime animation: ${subject} Clean line art, vibrant cel shading, detailed background, smooth motion. No text, no watermarks.`;

// Talking characters: the model renders the spoken line as real dialogue audio.
// The persona lands in the manifest so the editor's character mode can compose
// new lines for the same person; the sample line here is only the stock clip.
const character = (
  id: string,
  aspect: StockVideoAspect,
  persona: string,
  line: string
): CatalogItem => ({
  id,
  category: "Characters",
  aspect,
  persona,
  prompt: characterPrompt(persona, line),
});

// What must never show up in a stock clip. The model has no negative-prompt
// parameter, so this rides the prompt itself as an avoid clause (plain nouns;
// the prompt's "no text" line is belt-and-braces).
const NEGATIVE_PROMPT = "text overlay, captions, subtitles, watermark, logo, timestamp, split screen";

const CATALOG: CatalogItem[] = [
  // Talking Characters — one editable spoken line each, varied looks and sets.
  character("character-studio-host", "16:9", "a friendly man in his 30s with short dreadlocks, wearing a mustard crewneck, acoustic foam panels soft in the background", "So I tested this for thirty days, and honestly? The results surprised me."),
  character("character-loft-creator", "9:16", "a woman in her late 20s with a copper bob, freckles and no makeup, white wired earbuds in, a plant-filled loft blurred behind her", "Okay, quick story time — because this completely changed how I work."),
  character("character-office-mentor", "16:9", "a silver-haired man in his 50s with glasses and an open collar, warm afternoon window light on his face", "After twenty years in this industry, there's one lesson I keep coming back to."),
  character("character-kitchen-vlogger", "9:16", "a cheerful woman in her 40s in a linen apron, flour dusted on one cheek, a kitchen counter out of focus behind her", "You only need three ingredients for this — and you probably have them already."),
  character("character-cafe-analyst", "16:9", "a young man in his 20s with round glasses and a grey hoodie, a rainy café window bokeh behind him", "Let's break down what these numbers actually mean."),
  character("character-outdoor-coach", "9:16", "an athletic woman in her 30s with a high ponytail, slightly out of breath, loose hairs moving in the breeze on a park trail at golden hour", "Day one is the hardest — here's how to make it stick."),
  character("character-workshop-maker", "16:9", "a bearded man in his 40s in a denim work shirt with sawdust on the shoulder, woodworking shop shelves behind him", "Most people get this step wrong, so watch closely."),
  character("character-lounge-storyteller", "16:9", "an elegant woman in her 60s with silver hair and a burgundy scarf, warm lamplight from one side", "Now this — this is a story I've never told anyone."),
  character("character-gym-trainer", "16:9", "a muscular man in his 30s with a buzz cut, a light sheen of sweat, gym equipment blurred behind him", "Three sets. That's it. Let me show you why less is more."),
  character("character-startup-founder", "16:9", "a South Asian woman in her 30s in a blazer over a plain tee, a scribbled whiteboard out of focus behind her", "We almost ran out of money twice. Here's what saved us."),
  character("character-bookshop-owner", "16:9", "an East Asian man in his 60s in a knit cardigan, tall secondhand-bookshop shelves behind him", "People ask me why paper books survive. Well, let me tell you."),
  character("character-garden-guide", "9:16", "a Latina woman in her 50s in a sunhat, harsh midday sun making her squint a little, greenhouse plants behind her", "If your plants keep dying, you're probably doing this one thing."),
  character("character-music-producer", "16:9", "a young Black woman in her 20s with headphones around her neck, synthesizers and studio gear bokeh behind her", "Listen to what happens when I take the bass out."),
  character("character-street-reporter", "9:16", "a man in his 20s on a busy city sidewalk, wind blowing his hair across his forehead, traffic passing behind him", "We asked fifty people the same question — the answers blew us away."),
  character("character-chef-pass", "16:9", "a Middle Eastern man in his 40s in chef whites, steam and a bright kitchen pass out of focus behind him", "The secret isn't the sauce. It's the salt — and when you add it."),
  character("character-science-teacher", "16:9", "a woman in her 40s in a lab coat with safety glasses pushed up into her hair, a classroom lab behind her", "Everything you learned about this in school? Half of it is wrong."),
  character("character-travel-blogger", "9:16", "a man in his 30s in a backwards maroon cap and aviator glasses, evening sun on his face, an old-town square with string lights behind him", "This city gets skipped by everyone — and that's exactly why you should go."),
  character("character-finance-coach", "16:9", "a Black man in his 40s in a fitted sweater, a home-office bookshelf and desk lamp blurred behind him", "If you can save ten percent, you can retire early. Here's the math."),
  character("character-nurse-educator", "16:9", "a Filipina woman in her 30s in scrubs with a stethoscope around her neck, a bright clinic room behind her", "Most people take their blood pressure wrong. Watch this."),
  character("character-grandpa-gamer", "16:9", "a cheerful man in his 70s with a white beard, his face lit by shifting RGB keyboard glow in a dim room", "My grandson taught me this game. Now I coach him."),
  character("character-cafe-hopper", "9:16", "a stylish young Korean woman in her early 20s with wispy curtain bangs, long ash-brown hair, glossy lip tint and gold hoop earrings, walking down a sunny sidewalk toward a corner café with pastel awnings behind her", "I found the prettiest café in the city — come with me before everyone else finds it."),
  character("character-study-buddy", "9:16", "a young Korean woman in her early 20s with soft bangs and dark hair pinned up in a claw clip, wearing an oversized cream cardigan, a warm desk lamp and stacked notebooks blurred behind her", "It's almost midnight and I have three chapters left — let's finish this together."),
  character("character-business-lead", "16:9", "a polished Korean woman in her late 20s with sleek shoulder-length black hair and pearl earrings, in a tailored ivory blazer, a bright glass high-rise office blurred behind her", "I've sat through a thousand pitches. The good ones all start the same way."),

  // Business
  { id: "business-team-walkthrough", category: "Business", aspect: "16:9", prompt: clip("a slow tracking shot following a small team walking and talking through a bright modern office, glass walls and plants passing by.") },
  { id: "business-typing-macro", category: "Business", aspect: "16:9", prompt: clip("a close-up of hands typing on a laptop at a tidy desk, soft window light, shallow depth of field.") },

  // Nature
  { id: "nature-coast-aerial", category: "Nature", aspect: "16:9", prompt: clip("a drone shot rising over a foggy coastline at sunrise, waves rolling onto dark sand far below.") },
  { id: "nature-forest-rays", category: "Nature", aspect: "9:16", prompt: clip("sunbeams drifting through tall pines as morning fog moves slowly between the trunks, camera gliding forward at ground level.") },

  // Travel
  { id: "travel-market-walk", category: "Travel", aspect: "16:9", prompt: clip("a first-person walk through a lively evening street market, lanterns glowing, vendors and steam from food stalls on both sides.") },
  { id: "travel-beach-stroll", category: "Travel", aspect: "9:16", prompt: clip("a traveler walking barefoot along the waterline of a white-sand beach at golden hour, gentle waves washing over their footprints.") },

  // City
  { id: "city-night-traffic", category: "City", aspect: "16:9", prompt: clip("an elevated view of city traffic at night, headlight streams and neon reflections on wet asphalt.") },
  { id: "city-crosswalk-rush", category: "City", aspect: "16:9", prompt: clip("a busy scramble crosswalk from a high angle, crowds crossing in every direction as the light changes.") },

  // Technology
  { id: "tech-code-glow", category: "Technology", aspect: "16:9", prompt: clip("a slow push-in on a developer working at a dual-monitor setup in a dim room, screen glow on their face, code scrolling.") },
  { id: "tech-robot-assembly", category: "Technology", aspect: "16:9", prompt: clip("an industrial robot arm assembling components on a clean production line, precise repeated motion, cool white lighting.") },

  // Anime
  { id: "anime-rain-walk", category: "Anime", aspect: "9:16", prompt: animeClip("a figure with a glowing umbrella walking toward the viewer down a rain-slicked neon city street at night, puddles rippling.") },
  { id: "anime-cloud-drift", category: "Anime", aspect: "16:9", prompt: animeClip("towering summer clouds drifting over a green hillside town by the sea, cherry blossom petals carried on the wind.") },

  // Animal
  { id: "animal-dog-sprint", category: "Animal", aspect: "16:9", prompt: clip("a golden retriever sprinting along a beach at sunset in slow motion, sand kicking up, ears flying.") },
  { id: "animal-flock-sky", category: "Animal", aspect: "16:9", prompt: clip("a flock of birds wheeling across a pastel dusk sky over still water, reflections mirroring their turns.") },

  // Food & Drink
  { id: "food-coffee-pour", category: "Food & Drink", aspect: "16:9", prompt: clip("a slow-motion pour of steamed milk into espresso forming latte art, on a marble counter, steam curling upward.") },
  { id: "food-pan-sizzle", category: "Food & Drink", aspect: "16:9", prompt: clip("vegetables tossed in a sizzling wok over a high flame, embers and steam rising, close-up from the side.") },
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

/** Renders one clip and resolves to its mp4 bytes — submits a background
 * interaction, polls it to completion, then reads inline bytes or downloads
 * the signed URI. */
async function generateOne(client: GoogleGenAI, authClient: JWT, item: CatalogItem): Promise<Buffer> {
  let interaction = await client.interactions.create({
    model: MODEL,
    input: `${item.prompt} Avoid: ${NEGATIVE_PROMPT}.`,
    generation_config: { video_config: { task: "text_to_video" } } as never,
    response_format: { type: "video", aspect_ratio: item.aspect, resolution: "720p" } as never,
    background: true,
  });
  // requires_action is a non-terminal state too (same treatment the
  // production adapter gives it) — keep polling through it.
  while (interaction.status === "in_progress" || interaction.status === "requires_action") {
    await sleep(POLL_MS);
    interaction = await client.interactions.get(interaction.id);
  }
  if (interaction.status !== "completed") {
    const step = [...(interaction.steps ?? [])].reverse().find((st) => (st as { error?: { message?: string } }).error);
    const message = (step as { error?: { message?: string } } | undefined)?.error?.message;
    throw new Error(message ?? `video generation ${interaction.status}`);
  }
  const video = interaction.output_video;
  if (video?.data) return Buffer.from(video.data, "base64");
  if (video?.uri) {
    const token = await authClient.getAccessToken();
    const res = await fetch(video.uri, { headers: { Authorization: `Bearer ${token.token}` } });
    if (!res.ok) throw new Error(`could not download the rendered video (${res.status})`);
    return Buffer.from(await res.arrayBuffer());
  }
  throw new Error("no video in response");
}

/** The rendered file's real length: the model picks each clip's length
 * itself, so the manifest reports what actually rendered — placement math
 * trusts StockVideo.duration. */
function probeDuration(id: string): number {
  const proc = spawnSync("ffprobe", [
    "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0",
    path.join(OUT_DIR, `${id}.mp4`),
  ]);
  const sec = Number.parseFloat(proc.stdout?.toString().trim() ?? "");
  if (proc.status !== 0 || !Number.isFinite(sec) || sec <= 0) {
    throw new Error(`ffprobe could not read ${id}.mp4's duration`);
  }
  return Math.round(sec * 10) / 10;
}

/** First frame of the finished mp4 as the grid thumb, via ffmpeg → sharp. */
async function writeThumb(item: CatalogItem) {
  const proc = spawnSync(
    "ffmpeg",
    ["-v", "error", "-i", path.join(OUT_DIR, `${item.id}.mp4`), "-frames:v", "1", "-f", "image2pipe", "-vcodec", "png", "-"],
    { maxBuffer: 64 * 1024 * 1024 }
  );
  const png = proc.stdout;
  if (proc.status !== 0 || !png || png.length === 0) {
    throw new Error(`ffmpeg could not read a poster frame: ${proc.stderr?.toString() ?? "unknown error"}`);
  }
  const frame = sharp(png);
  const { width = 0, height = 0 } = await frame.metadata();
  const scale = THUMB_EDGE / Math.max(width, height, 1);
  const thumb = await frame
    .resize(Math.round(width * scale), Math.round(height * scale))
    .webp({ quality: 75, smartSubsample: true })
    .toBuffer();
  await writeFile(path.join(OUT_DIR, `${item.id}.thumb.webp`), thumb);
}

/** Vision pass over the poster frame: extracts the concrete, searchable
 * keywords for what is actually visible — objects, animals, people, setting,
 * and time/weather. */
async function tagOne(client: GoogleGenAI, item: CatalogItem): Promise<string[]> {
  const thumb = await readFile(path.join(OUT_DIR, `${item.id}.thumb.webp`));
  const response = await client.models.generateContent({
    model: TAG_MODEL,
    contents: [
      {
        role: "user",
        parts: [
          { inlineData: { mimeType: "image/webp", data: thumb.toString("base64") } },
          {
            text: "List 10-20 search keywords for everything visible in this image: every distinct object (e.g. tree, dog, cup, laptop), animals, people, the setting (e.g. beach, road, office, forest), and time of day or weather if evident. Lowercase, one or two words each. Respond with a JSON array of strings only.",
          },
        ],
      },
    ],
    config: { responseMimeType: "application/json" },
  });
  const parsed = JSON.parse(response.text ?? "[]") as unknown;
  if (!Array.isArray(parsed)) throw new Error("tag response is not an array");
  const tags = parsed
    .filter((t): t is string => typeof t === "string")
    .map((t) => t.trim().toLowerCase())
    .filter(Boolean);
  if (tags.length === 0) throw new Error("no tags in response");
  return [...new Set(tags)];
}

/** Tags from the current manifest, keyed by id — reused so re-runs only call
 * the vision model for new or untagged clips. */
async function existingTags(): Promise<Map<string, string[]>> {
  const byId = new Map<string, string[]>();
  try {
    const { STOCK_VIDEOS } = await import("../src/cut/lib/stockVideoManifest");
    for (const entry of STOCK_VIDEOS as { id: string; tags?: string[] }[]) {
      if (entry.tags?.length) byId.set(entry.id, entry.tags);
    }
  } catch {
    // No manifest yet — every clip gets a fresh tagging pass.
  }
  return byId;
}

async function writeManifest(done: Set<string>, tags: Map<string, string[]>) {
  const entries = CATALOG.filter((c) => done.has(c.id)).map((c) => ({
    id: c.id,
    category: c.category,
    prompt: c.prompt,
    ...(c.persona ? { persona: c.persona } : {}),
    tags: tags.get(c.id) ?? [],
    aspect: c.aspect,
    file: `/cut-stock-video/${c.id}.mp4`,
    thumb: `/cut-stock-video/${c.id}.thumb.webp`,
    duration: probeDuration(c.id),
  }));
  const body = `// Generated by scripts/generate-stock-videos.ts — do not edit by hand.
import type { StockVideo } from "./stock";

export const STOCK_VIDEOS: StockVideo[] = ${JSON.stringify(entries, null, 2)};
`;
  await writeFile(MANIFEST, body);
}

async function main() {
  const { client, authClient, project } = makeClient();
  await mkdir(OUT_DIR, { recursive: true });

  const done = new Set<string>(CATALOG.filter((c) => existsSync(path.join(OUT_DIR, `${c.id}.mp4`))).map((c) => c.id));
  const todo = CATALOG.filter((c) => !done.has(c.id));
  console.log(`model=${MODEL} project=${project} existing=${done.size} generating=${todo.length}`);

  let failed = 0;
  const queue = [...todo];
  const worker = async () => {
    for (let item = queue.shift(); item; item = queue.shift()) {
      for (let attempt = 1; ; attempt++) {
        try {
          const video = await generateOne(client, authClient, item);
          await writeFile(path.join(OUT_DIR, `${item.id}.mp4`), video);
          await writeThumb(item);
          done.add(item.id);
          console.log(`✓ ${item.id} (${item.aspect})`);
          break;
        } catch (e) {
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

  // A finished clip can predate its thumb (an interrupted earlier run); fill in
  // any missing posters before tagging reads them.
  for (const item of CATALOG) {
    if (done.has(item.id) && !existsSync(path.join(OUT_DIR, `${item.id}.thumb.webp`))) {
      await writeThumb(item).catch((e) => console.error(`✗ thumb ${item.id}: ${e instanceof Error ? e.message : e}`));
    }
  }

  const tags = await existingTags();
  for (const item of CATALOG) {
    if (!done.has(item.id) || tags.has(item.id)) continue;
    try {
      tags.set(item.id, await tagOne(client, item));
      console.log(`✓ tags ${item.id}`);
    } catch (e) {
      failed++;
      console.error(`✗ tags ${item.id}: ${e instanceof Error ? e.message : e}`);
    }
  }

  await writeManifest(done, tags);
  console.log(`manifest: ${done.size}/${CATALOG.length} clips${failed ? `, ${failed} failed` : ""}`);
  if (failed) process.exitCode = 1;
}

await main();
