import { beforeEach, expect, test } from "bun:test";
import { commandHints } from "@/clients/chatgpt/server/catalog";
import { REVIEWED } from "@/clients/chatgpt/server/reviewedListing";
import { runAiTool } from "@/cut/lib/aiTools";
import { richDoc } from "@/cut/lib/fixtures/richDoc";
import { useEditor } from "@/cut/lib/store";

// OpenAI rejects a tool whose hints say more or less than it does. A tool
// ChatGPT sees as non-destructive has to leave every item and setting the
// project already holds as it was; this runs each one on a full edit and
// compares. Destructive tools may do anything, so they need no run.

const CONTENT = ["clips", "transitions", "audioClips", "overlays", "subtitles", "guideLines", "aspect", "background", "colorSpace", "magnet"] as const;

type Content = Record<(typeof CONTENT)[number], unknown>;
const content = (): Content => {
  const state = useEditor.getState() as unknown as Content;
  return structuredClone(Object.fromEntries(CONTENT.map((key) => [key, state[key]]))) as Content;
};

/** Where `after` changed or dropped something `before` held. New entries
 * are allowed: in an id-keyed list, a new id; in an object, a new key. */
function changes(before: unknown, after: unknown, at: string, out: string[]): void {
  if (Array.isArray(before) && before.every((item) => item && typeof item === "object" && "id" in item)) {
    const next = new Map((Array.isArray(after) ? after : []).map((item: { id: string }) => [item.id, item]));
    for (const item of before as { id: string }[]) {
      changes(item, next.get(item.id), `${at}[${item.id}]`, out);
    }
    return;
  }
  if (before && typeof before === "object" && !Array.isArray(before)) {
    if (!after || typeof after !== "object") {
      out.push(at);
      return;
    }
    for (const [key, value] of Object.entries(before)) {
      changes(value, (after as Record<string, unknown>)[key], `${at}.${key}`, out);
    }
    return;
  }
  if (JSON.stringify(before) !== JSON.stringify(after)) {
    out.push(at);
  }
}

/** A run: calls that set the scene, the call checked, and calls that
 * return to the scene before it is compared. */
type Call = [string, Record<string, unknown>];
type Run = { setup?: Call[]; input: Record<string, unknown>; after?: Call[] };

// One call per non-destructive editor command, on the rich edit's own ids.
const RUNS: Record<string, Run> = {
  add_title: { input: { text: "HELLO", start: 1, end: 2 } },
  add_shape: { input: { shape: "rect", start: 1, end: 2 } },
  add_sticker: { input: { asset_id: "s0", start: 1, end: 2 } },
  add_effect: { input: { effect: "grain", start: 1, end: 2 } },
  subtitles_add_track: { input: { language: "ko" } },
  seek: { input: { t: 3 } },
  select: { input: { kind: "clip", id: "c0" } },
  // Switching away and back hands over the same edit.
  switch_timeline: { input: { timeline: "second" }, after: [["switch_timeline", { timeline: "main" }]] },
  copy_from_timeline: { setup: [["switch_timeline", { timeline: "second" }], ["add_title", { text: "HERE", start: 0, end: 1 }]], input: { timeline: "main", ids: ["a0", "t0"] } },
  save_template: { input: { name: "Opening", item_ids: ["c0", "t0"] } },
};

// These reach a hosted model, the cloud, or a media decoder, which a unit run
// has none of. Each lands its result where nothing sits (a free audio lane, a
// new element, a new asset or project) or writes only the asset's own maps.
const OUT_OF_PROCESS = new Set([
  "create_sticker", "voiceover_generate", "generate_music", "read_subtitles_aloud",
  "copy_project_media", "make_template", "template_add", "select_items", "wait_for_uploads",
  "watch_video", "listen_audio", "detect_cuts",
]);

// The first-class tools act on the cloud project from the server.
const SERVER_TOOLS = new Set(["create_project", "export_video", "import_media", "render_preview"]);

beforeEach(async () => {
  const doc = richDoc();
  await useEditor.getState().openProjectDoc("p1", doc, doc.assets.map((asset) => ({ ...asset, url: "" })));
});

const additive = REVIEWED.tools.filter((tool) => tool.annotations && !tool.annotations.readOnlyHint && !tool.annotations.destructiveHint);

for (const name of Object.keys(RUNS)) {
  test(`${name} leaves what the project holds as it was`, async () => {
    expect(commandHints(name).destructiveHint).toBe(false);
    for (const [step, input] of RUNS[name].setup ?? []) {
      await runAiTool(step, input);
    }
    const before = content();
    await runAiTool(name, RUNS[name].input);
    for (const [step, input] of RUNS[name].after ?? []) {
      await runAiTool(step, input);
    }
    const out: string[] = [];
    changes(before, content(), name, out);
    expect(out).toEqual([]);
  });
}

test("every non-destructive tool is run here or named for where it runs", () => {
  const unaccounted = additive.map((tool) => tool.name).filter((name) => !(name in RUNS) && !OUT_OF_PROCESS.has(name) && !SERVER_TOOLS.has(name));
  expect(unaccounted).toEqual([]);
});

test("the check catches a placement that slides the clips after it", async () => {
  const before = content();
  await runAiTool("add_clip", { asset_id: "v1", index: 0 });
  const out: string[] = [];
  changes(before, content(), "add_clip", out);
  expect(out.length).toBeGreaterThan(0);
});
