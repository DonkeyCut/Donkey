import { beforeEach, expect, test } from "bun:test";

// A title's font is checked against the registry: an id it does not know is
// refused, so the assistant learns its face did not land.

const { runAiTool } = await import("./aiTools");
const { useEditor } = await import("./store");

beforeEach(() => {
  useEditor.setState({ projectId: "p", loaded: true, aspect: "9:16", assets: [], clips: [], audioClips: [], overlays: [] } as never);
});

test("a known font lands on the title", async () => {
  const t = (await runAiTool("add_title", { text: "HI", start: 0, end: 1, font: "serif" })) as { id: string };
  const o = useEditor.getState().overlays.find((x) => x.id === t.id) as { font?: string };
  expect(o.font).toBe("serif");
});

test("an unknown font is refused, naming it", async () => {
  await expect(runAiTool("add_title", { text: "HI", start: 0, end: 1, font: "nosuchface" })).rejects.toThrow(/nosuchface/);
  expect(useEditor.getState().overlays.length).toBe(0);
});
