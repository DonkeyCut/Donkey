// Lists the most-downloaded sounds in the ElevenLabs sound library, the
// community catalog behind its Explore tab, so the bundled catalog in
// generate-stock-sfx.ts can be checked against what people actually reach
// for: a sound that ranks high there and has no row here is a gap to render.
// Each line is downloads, the library's category, and the prompt.
//
//   cd site && ./node_modules/.bin/bun scripts/sfx-library-top.ts [pages] [search]
//
// Needs ELEVENLABS_API_KEY (bun auto-loads site/.env). A page is 100 sounds;
// the default reads ten. A search term narrows the list to matching prompts.

const PAGE = 100;
const pages = Number.parseInt(process.argv[2] ?? "10", 10);
const search = process.argv[3] ?? "";
const key = process.env.ELEVENLABS_API_KEY;
if (!key) throw new Error("ELEVENLABS_API_KEY is not set");

interface Shared {
  generation_id: string;
  text: string;
  category: string;
  purchased_count: number;
}

const seen = new Map<string, Shared>();
for (let page = 1; page <= pages; page++) {
  const q = new URLSearchParams({ page_size: String(PAGE), sort: "purchased_count", page: String(page) });
  if (search) q.set("search", search);
  const res = await fetch(`https://api.us.elevenlabs.io/v1/shared-sound-generations?${q}`, {
    headers: { "xi-api-key": key },
  });
  if (!res.ok) throw new Error(`library page ${page}: ${res.status} ${await res.text()}`);
  const body = (await res.json()) as { shared_sound_generations: Shared[]; has_more: boolean };
  for (const s of body.shared_sound_generations) seen.set(s.generation_id, s);
  if (!body.has_more) break;
}
const rows = [...seen.values()].sort((a, b) => b.purchased_count - a.purchased_count);
for (const r of rows) {
  const text = r.text.replace(/\s+/g, " ").trim().slice(0, 120);
  console.log(`${String(r.purchased_count).padStart(5)}  ${r.category.padEnd(10)}  ${text}`);
}
