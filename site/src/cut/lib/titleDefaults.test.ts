import { beforeEach, expect, test } from "bun:test";
import { useEditor } from "./store";
import { emptySubtitles, isTextOverlay } from "./types";

// The editor remembers the last title's look for the next one a person adds.
// The assistant's add_title states its own defaults, so a remembered look from
// another title must not ride along on what it leaves out.
const remembered = { font: "bangers", size: 140, letterSpacing: 0.55, color: "#FF0000", shadow: false };
globalThis.localStorage ??= {
  getItem: () => JSON.stringify(remembered),
  setItem: () => {},
  removeItem: () => {},
} as unknown as Storage;

const { runAiTool } = await import("./aiTools");

beforeEach(() =>
  useEditor.setState({
    projectId: "p1",
    aspect: "16:9",
    assets: [],
    clips: [],
    audioClips: [],
    overlays: [],
    subtitles: emptySubtitles(),
    background: "#000000",
  })
);

test("add_title starts from the defaults its schema states", async () => {
  await runAiTool("add_title", { text: "CLIP 1", font: "impact", start: 0, end: 1 });
  const t = useEditor.getState().overlays.filter(isTextOverlay)[0];
  expect(t.font).toBe("impact");
  expect(t.size).toBe(88);
  expect(t.letterSpacing).toBeUndefined();
  expect(t.color).toBe("#FFFFFF");
  expect(t.shadow).toBe(true);
});

test("a title the person adds still takes the remembered look", () => {
  useEditor.getState().addOverlay();
  const t = useEditor.getState().overlays.filter(isTextOverlay)[0];
  expect(t.letterSpacing).toBe(0.55);
  expect(t.font).toBe("bangers");
});
