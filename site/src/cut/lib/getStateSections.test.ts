import { expect, test } from "bun:test";
import { runAiTool } from "./aiTools";
import { useEditor } from "./store";

// A cut with seventy elements read back whole came out too large for a tool
// result, so the chat could not check its own lane moves. A read names the
// sections it needs.

test("get_state with sections returns only those, plus the playhead", async () => {
  useEditor.setState({ clips: [], overlays: [], transitions: [], assets: [],
    audioClips: [{ id: "s1", assetId: "a", start: 0, in: 0, out: 1, volume: 1 }] });
  const res = (await runAiTool("get_state", { sections: ["soundtrack", "overlays"] })) as Record<string, unknown>;
  expect(Object.keys(res).sort()).toEqual(["overlays", "playhead", "soundtrack"]);
});

test("an unknown section is named", async () => {
  const err = await runAiTool("get_state", { sections: ["lanes"] }).catch((e: unknown) => e);
  expect(err instanceof Error && err.message.includes("soundtrack")).toBe(true);
});
