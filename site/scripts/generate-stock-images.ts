// Generates the bundled Cut stock-image catalog with the same Vertex image model
// the app uses (gemini-3.1-flash-image), then writes the typed manifest the
// editor imports. Idempotent: items whose file already exists are skipped, so
// re-running fills gaps or picks up new catalog entries only.
//
//   cd site && ./node_modules/.bin/bun scripts/generate-stock-images.ts
//
// Needs GOOGLE_APPLICATION_CREDENTIALS_JSON (bun auto-loads site/.env). Each
// image is checked for baked-in letterbox bars (regenerated when found, trimmed
// as a last resort), cropped to its exact aspect, and written twice: a
// near-native WebP the lightbox and timeline use, and a small grid thumb.
//
// After generation, every image is tagged: a vision pass looks at the finished
// asset and extracts the searchable keywords (objects, animals, setting) the
// editor's search box matches. Tags already in the manifest are reused, so
// re-running only tags new or untagged images.

import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { GoogleGenAI } from "@google/genai";
import { JWT } from "google-auth-library";
import sharp from "sharp";

import { geminiModels } from "../src/lib/inference/gemini-models";
import type { StockAspect, StockCategory } from "../src/cut/lib/stock";

interface CatalogItem {
  id: string;
  category: StockCategory;
  aspect: StockAspect;
  prompt: string;
}

const MODEL = geminiModels.flashImage;
const TAG_MODEL = geminiModels.flash;
const OUT_DIR = path.join(import.meta.dirname, "..", "public", "cut-stock");
const MANIFEST = path.join(import.meta.dirname, "..", "src", "cut", "lib", "stockManifest.ts");
const CONCURRENCY = 4;

/** Full-asset dimensions per aspect — just under the model's native output so
 * the exact-ratio crop only ever shaves edges, never upscales. */
const FULL_SIZE: Record<StockAspect, [number, number]> = {
  "16:9": [1280, 720],
  "9:16": [720, 1280],
  "1:1": [1024, 1024],
};
/** Longest thumb edge — the browse grid renders tiles well under this. */
const THUMB_EDGE = 512;

const photo = (subject: string) =>
  `Professional stock photograph: ${subject} Natural lighting, shallow depth of field, sharp focus, realistic color grading. No text, no watermarks, no logos.`;

const anime = (subject: string) =>
  `High-quality anime illustration: ${subject} Clean line art, vibrant cel shading, detailed background, cinematic composition. No text, no watermarks.`;

const CATALOG: CatalogItem[] = [
  // Business
  { id: "business-boardroom", category: "Business", aspect: "16:9", prompt: photo("a diverse team in a modern boardroom reviewing charts and documents spread across a large table, mid-discussion.") },
  { id: "business-whiteboard", category: "Business", aspect: "9:16", prompt: photo("a young founder sketching a product flow on a glass whiteboard in a bright startup loft, colleagues watching.") },
  { id: "business-handshake", category: "Business", aspect: "16:9", prompt: photo("a close-up handshake between two professionals in a sunlit office lobby, blurred glass architecture behind.") },
  { id: "business-open-office", category: "Business", aspect: "16:9", prompt: photo("an open-plan office at golden hour, people working at standing desks, warm light streaming through tall windows.") },
  { id: "business-presentation", category: "Business", aspect: "16:9", prompt: photo("a woman presenting quarterly growth charts on a wall screen to an attentive small team in a conference room.") },
  { id: "business-desk-flatlay", category: "Business", aspect: "1:1", prompt: photo("a tidy flat-lay of a laptop, notebook, espresso cup, and phone on a light oak desk, viewed straight down.") },

  // Nature
  { id: "nature-misty-valley", category: "Nature", aspect: "16:9", prompt: photo("a misty mountain valley at sunrise, layered ridgelines fading into soft golden haze.") },
  { id: "nature-waterfall", category: "Nature", aspect: "16:9", prompt: photo("a tropical waterfall pouring into a clear jungle pool, lush ferns and volcanic rock around it.") },
  { id: "nature-dunes", category: "Nature", aspect: "16:9", prompt: photo("rippled sand dunes at dusk, long shadows and a deep orange-to-violet gradient sky.") },
  { id: "nature-pine-fog", category: "Nature", aspect: "9:16", prompt: photo("tall pine trees rising through morning fog, shot upward from the forest floor.") },
  { id: "nature-ocean-wave", category: "Nature", aspect: "16:9", prompt: photo("a turquoise ocean wave curling and catching backlight, spray frozen mid-air.") },
  { id: "nature-wildflowers", category: "Nature", aspect: "1:1", prompt: photo("a macro of wildflowers in a summer meadow, one poppy in crisp focus against a creamy bokeh field.") },

  // Travel
  { id: "travel-train-station", category: "Travel", aspect: "16:9", prompt: photo("two backpackers walking through a grand old train station, a vintage orange train waiting on the platform.") },
  { id: "travel-old-town", category: "Travel", aspect: "9:16", prompt: photo("a narrow cobblestone alley in a European old town, flower boxes on shutters, warm evening lanterns.") },
  { id: "travel-airplane-wing", category: "Travel", aspect: "16:9", prompt: photo("an airplane wing over a sea of sunset clouds, window-seat perspective.") },
  { id: "travel-boardwalk", category: "Travel", aspect: "16:9", prompt: photo("a wooden boardwalk lined with palm trees leading to a white-sand beach and clear shallow water.") },
  { id: "travel-balloons", category: "Travel", aspect: "16:9", prompt: photo("dozens of hot-air balloons drifting over a rocky valley at dawn, soft pastel sky.") },
  { id: "travel-flatlay", category: "Travel", aspect: "1:1", prompt: photo("a flat-lay of a passport, film camera, sunglasses, and a paper map with a marked route, viewed from above.") },

  // City
  { id: "city-skyline", category: "City", aspect: "16:9", prompt: photo("a modern city skyline across the water at blue hour, glass towers reflecting the last light.") },
  { id: "city-neon-crosswalk", category: "City", aspect: "9:16", prompt: photo("a rainy neon-lit crosswalk at night, umbrellas and reflections on wet asphalt.") },
  { id: "city-rooftop", category: "City", aspect: "16:9", prompt: photo("a rooftop terrace view over downtown at sunset, string lights in the foreground.") },
  { id: "city-subway", category: "City", aspect: "16:9", prompt: photo("a subway train arriving in motion blur while commuters wait on the platform.") },
  { id: "city-cafe-corner", category: "City", aspect: "16:9", prompt: photo("a sidewalk café on a leafy street corner, bicycles parked outside, morning light.") },
  { id: "city-aerial-grid", category: "City", aspect: "1:1", prompt: photo("a straight-down aerial of a busy city intersection, crosswalk stripes and tiny cars forming a clean grid.") },

  // Technology
  { id: "tech-coding", category: "Technology", aspect: "16:9", prompt: photo("a developer at a dual-monitor setup writing code in a dim room, screen glow on their face.") },
  { id: "tech-server-room", category: "Technology", aspect: "16:9", prompt: photo("a long server-room aisle with racks of blinking status lights fading into the distance.") },
  { id: "tech-circuit-macro", category: "Technology", aspect: "1:1", prompt: photo("a macro of a circuit board, gold traces and a CPU die in sharp focus, shallow depth of field.") },
  { id: "tech-robot-arm", category: "Technology", aspect: "16:9", prompt: photo("an industrial robot arm assembling components on a clean production line, cool white lighting.") },
  { id: "tech-vr-headset", category: "Technology", aspect: "9:16", prompt: photo("a person wearing a VR headset reaching out, lit by soft violet and cyan studio light.") },
  { id: "tech-dashboard", category: "Technology", aspect: "16:9", prompt: photo("a large monitor showing a clean analytics dashboard with charts, a blurred office behind it.") },

  // Anime
  { id: "anime-neon-street", category: "Anime", aspect: "9:16", prompt: anime("a rain-slicked neon city street at night, a figure with a glowing umbrella walking toward the viewer.") },
  { id: "anime-cherry-blossoms", category: "Anime", aspect: "16:9", prompt: anime("a student on a hilltop path under falling cherry blossoms, a town and sea far below.") },
  { id: "anime-mecha", category: "Anime", aspect: "16:9", prompt: anime("a giant mecha standing guard over a futuristic city at sunset, clouds parting dramatically.") },
  { id: "anime-ramen-shop", category: "Anime", aspect: "16:9", prompt: anime("a cozy late-night ramen shop interior, steam rising from bowls, warm lantern light.") },
  { id: "anime-floating-islands", category: "Anime", aspect: "16:9", prompt: anime("a fantasy landscape of floating islands with waterfalls spilling into the sky, airships drifting between them.") },
  { id: "anime-portrait", category: "Anime", aspect: "1:1", prompt: anime("a close-up portrait of a silver-haired adventurer with bright green eyes, wind-blown hair, golden-hour light.") },

  // Animal
  { id: "animal-retriever-beach", category: "Animal", aspect: "16:9", prompt: photo("a golden retriever sprinting along a beach at sunset, sand kicking up, ears flying.") },
  { id: "animal-cat-window", category: "Animal", aspect: "1:1", prompt: photo("a tabby cat sitting in soft window light, dust motes in the sunbeam.") },
  { id: "animal-fox-snow", category: "Animal", aspect: "16:9", prompt: photo("a red fox stepping through fresh snow in a quiet forest, breath visible in the cold air.") },
  { id: "animal-macaw", category: "Animal", aspect: "9:16", prompt: photo("a scarlet macaw perched on a branch, vivid red and blue feathers against deep green jungle bokeh.") },
  { id: "animal-elephants", category: "Animal", aspect: "16:9", prompt: photo("a family of elephants at a watering hole at dusk, golden dust in the air.") },
  { id: "animal-horse", category: "Animal", aspect: "16:9", prompt: photo("a chestnut horse galloping through a misty field at dawn, mane streaming.") },

  // Food & Drink
  { id: "food-brunch", category: "Food & Drink", aspect: "16:9", prompt: photo("a generous brunch spread on a rustic table: pancakes, fruit, coffee, and fresh juice, soft morning light.") },
  { id: "food-latte-art", category: "Food & Drink", aspect: "1:1", prompt: photo("a close-up of latte art in a ceramic cup on a marble counter, steam curling upward.") },
  { id: "food-sushi", category: "Food & Drink", aspect: "16:9", prompt: photo("an elegant sushi platter on dark slate, nigiri and rolls arranged with pickled ginger and wasabi.") },
  { id: "food-tacos", category: "Food & Drink", aspect: "16:9", prompt: photo("three street tacos with charred meat, cilantro, and lime on a paper-lined tray, market lights behind.") },
  { id: "food-smoothie-bowl", category: "Food & Drink", aspect: "9:16", prompt: photo("a vibrant berry smoothie bowl topped with granola, banana, and chia seeds, shot from a high angle.") },
  { id: "food-pizza", category: "Food & Drink", aspect: "16:9", prompt: photo("a wood-fired margherita pizza fresh from the oven, bubbling mozzarella and basil, embers glowing behind.") },
];

function makeClient(): { client: GoogleGenAI; project: string } {
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
  return { client, project: creds.project_id };
}

const aspectHint: Record<StockAspect, string> = {
  "16:9": "16:9 widescreen",
  "9:16": "9:16 vertical",
  "1:1": "1:1 square",
};

async function generateOne(client: GoogleGenAI, item: CatalogItem, antiBar: boolean): Promise<Buffer> {
  const lines = [item.prompt, `Compose the image in a ${aspectHint[item.aspect]} frame.`];
  if (antiBar) {
    lines.push(
      "The scene must fill the entire frame edge to edge — absolutely no black or white bars, borders, letterboxing, or frames around the image."
    );
  }
  const contents = [{ role: "user", parts: [{ text: lines.join("\n\n") }] }];
  // imageConfig pins the output aspect on models that honor it; the prompt line
  // above steers the rest. Fall back to prompt-only if the field is rejected.
  let response;
  try {
    response = await client.models.generateContent({
      model: MODEL,
      contents,
      config: {
        responseModalities: ["IMAGE", "TEXT"],
        imageConfig: { aspectRatio: item.aspect },
      } as Record<string, unknown>,
    });
  } catch {
    response = await client.models.generateContent({
      model: MODEL,
      contents,
      config: { responseModalities: ["IMAGE", "TEXT"] },
    });
  }
  const parts = response.candidates?.[0]?.content?.parts ?? [];
  for (const part of parts) {
    const data = part.inlineData?.data;
    if (data) return Buffer.from(data, "base64");
  }
  throw new Error("no image in response");
}

interface Bars {
  top: number;
  bottom: number;
  left: number;
  right: number;
  width: number;
  height: number;
}

/** Measures baked-in letterbox bars: a bar is a run of rows/columns that are
 * all one solid color — the color of the outermost edge. Anchoring every row
 * to the edge color keeps gradients (sky, walls) untouched: they drift past
 * the tolerance within a few rows, a rendered bar never does. */
async function measureBars(image: Buffer): Promise<Bars> {
  const { data, info } = await sharp(image).raw().toBuffer({ resolveWithObject: true });
  const { width, height, channels } = info;
  const px = (x: number, y: number) => {
    const i = (y * width + x) * channels;
    return [data[i], data[i + 1], data[i + 2]] as const;
  };
  const isBar = (samples: (readonly [number, number, number])[], ref: readonly [number, number, number]) =>
    samples.every(([r, g, b]) => Math.abs(r - ref[0]) + Math.abs(g - ref[1]) + Math.abs(b - ref[2]) < 24);
  const rowSamples = (y: number) => {
    const step = Math.max(1, Math.floor(width / 64));
    const out: (readonly [number, number, number])[] = [];
    for (let x = 0; x < width; x += step) out.push(px(x, y));
    return out;
  };
  const colSamples = (x: number) => {
    const step = Math.max(1, Math.floor(height / 64));
    const out: (readonly [number, number, number])[] = [];
    for (let y = 0; y < height; y += step) out.push(px(x, y));
    return out;
  };
  const topRef = px(Math.floor(width / 2), 0);
  const bottomRef = px(Math.floor(width / 2), height - 1);
  const leftRef = px(0, Math.floor(height / 2));
  const rightRef = px(width - 1, Math.floor(height / 2));
  let top = 0, bottom = 0, left = 0, right = 0;
  while (top < height / 3 && isBar(rowSamples(top), topRef)) top++;
  while (bottom < height / 3 && isBar(rowSamples(height - 1 - bottom), bottomRef)) bottom++;
  while (left < width / 3 && isBar(colSamples(left), leftRef)) left++;
  while (right < width / 3 && isBar(colSamples(right), rightRef)) right++;
  return { top, bottom, left, right, width, height };
}

const barPixels = (b: Bars) => Math.max(b.top, b.bottom) / b.height + Math.max(b.left, b.right) / b.width;
const hasBars = (b: Bars) => b.top + b.bottom > b.height * 0.02 || b.left + b.right > b.width * 0.02;

/** Trims measured bars, center-crops to the exact aspect, and writes the full
 * asset plus the grid thumb as WebP. */
async function finalize(image: Buffer, bars: Bars, item: CatalogItem) {
  const [fullW, fullH] = FULL_SIZE[item.aspect];
  const content = sharp(image).extract({
    left: bars.left,
    top: bars.top,
    width: bars.width - bars.left - bars.right,
    height: bars.height - bars.top - bars.bottom,
  });
  const full = await content
    .resize(fullW, fullH, { fit: "cover" })
    .webp({ quality: 82, smartSubsample: true })
    .toBuffer();
  await writeFile(path.join(OUT_DIR, `${item.id}.webp`), full);
  const scale = THUMB_EDGE / Math.max(fullW, fullH);
  await sharp(full)
    .resize(Math.round(fullW * scale), Math.round(fullH * scale))
    .webp({ quality: 75, smartSubsample: true })
    .toBuffer()
    .then((thumb) => writeFile(path.join(OUT_DIR, `${item.id}.thumb.webp`), thumb));
}

/** Vision pass over a finished asset: extracts the concrete, searchable
 * keywords for what is actually visible — objects (tree, cup, laptop),
 * animals, people, setting (beach, road, office), and time/weather. */
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
 * the vision model for new or untagged images. */
async function existingTags(): Promise<Map<string, string[]>> {
  const byId = new Map<string, string[]>();
  try {
    const { STOCK_IMAGES } = await import("../src/cut/lib/stockManifest");
    for (const entry of STOCK_IMAGES as { id: string; tags?: string[] }[]) {
      if (entry.tags?.length) byId.set(entry.id, entry.tags);
    }
  } catch {
    // No manifest yet — every image gets a fresh tagging pass.
  }
  return byId;
}

async function writeManifest(done: Set<string>, tags: Map<string, string[]>) {
  const entries = CATALOG.filter((c) => done.has(c.id)).map((c) => ({
    id: c.id,
    category: c.category,
    prompt: c.prompt,
    tags: tags.get(c.id) ?? [],
    aspect: c.aspect,
    file: `/cut-stock/${c.id}.webp`,
    thumb: `/cut-stock/${c.id}.thumb.webp`,
  }));
  const body = `// Generated by scripts/generate-stock-images.ts — do not edit by hand.
import type { StockImage } from "./stock";

export const STOCK_IMAGES: StockImage[] = ${JSON.stringify(entries, null, 2)};
`;
  await writeFile(MANIFEST, body);
}

/** Generates until an attempt comes back bar-free (up to three), then falls
 * back to the least-barred attempt — finalize() trims its bars away. */
async function produceOne(client: GoogleGenAI, item: CatalogItem) {
  let best: { image: Buffer; bars: Bars } | null = null;
  for (let attempt = 1; attempt <= 3; attempt++) {
    const image = await generateOne(client, item, attempt > 1);
    const bars = await measureBars(image);
    if (!best || barPixels(bars) < barPixels(best.bars)) best = { image, bars };
    if (!hasBars(bars)) break;
    console.warn(`bars on ${item.id} (attempt ${attempt}): t${bars.top} b${bars.bottom} l${bars.left} r${bars.right}`);
  }
  if (!best) throw new Error("no image generated");
  await finalize(best.image, best.bars, item);
}

async function main() {
  const { client, project } = makeClient();
  await mkdir(OUT_DIR, { recursive: true });

  const done = new Set<string>(CATALOG.filter((c) => existsSync(path.join(OUT_DIR, `${c.id}.webp`))).map((c) => c.id));
  const todo = CATALOG.filter((c) => !done.has(c.id));
  console.log(`model=${MODEL} project=${project} existing=${done.size} generating=${todo.length}`);

  let failed = 0;
  const queue = [...todo];
  const worker = async () => {
    for (let item = queue.shift(); item; item = queue.shift()) {
      for (let attempt = 1; ; attempt++) {
        try {
          await produceOne(client, item);
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

  const tags = await existingTags();
  const tagQueue = CATALOG.filter((c) => done.has(c.id) && !tags.has(c.id));
  console.log(`tagging ${tagQueue.length} images (${tags.size} already tagged)`);
  const tagWorker = async () => {
    for (let item = tagQueue.shift(); item; item = tagQueue.shift()) {
      for (let attempt = 1; ; attempt++) {
        try {
          tags.set(item.id, await tagOne(client, item));
          console.log(`✓ tags ${item.id}: ${tags.get(item.id)!.join(", ")}`);
          break;
        } catch (e) {
          if (attempt >= 2) {
            failed++;
            console.error(`✗ tags ${item.id}: ${e instanceof Error ? e.message : e}`);
            break;
          }
          console.warn(`retrying tags ${item.id}…`);
        }
      }
    }
  };
  await Promise.all(Array.from({ length: CONCURRENCY }, tagWorker));

  await writeManifest(done, tags);
  console.log(`manifest: ${done.size}/${CATALOG.length} images${failed ? `, ${failed} failed` : ""}`);
  if (failed) process.exitCode = 1;
}

await main();
