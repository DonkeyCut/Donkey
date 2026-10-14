import { afterAll, expect, test } from "bun:test";
import { stubModule } from "@/lib/testing/stubModule";
import { cutMode, setCutMode } from "./backend";
import { useEditor } from "./store";

// A cloud listen reads its stretch off the browser's own render of the sound.
// The render hands back a few bytes, so what is pinned is the span the call
// asks for and the answer it gives.
const spans: { from: number; to?: number }[] = [];
let connection: "up" | "dropped" = "up";
await stubModule<typeof import("./media")>("./media", import.meta.url, {
  renderAudioSpanWav: async (_url: string, from: number, to?: number) => {
    if (connection === "dropped") {
      throw new TypeError("Failed to fetch");
    }
    spans.push({ from, to });
    return new Blob([new Uint8Array(64)], { type: "audio/wav" });
  },
});
await stubModule<typeof import("./watch/sweep")>("./watch/sweep", import.meta.url, { queueWatchSweep: () => {} });
const { runAiTool } = await import("./aiTools");

const ambient = cutMode();
setCutMode("cloud");
afterAll(() => setCutMode(ambient));

const project = () =>
  useEditor.setState({
    projectId: "p",
    clips: [],
    overlays: [],
    transitions: [],
    audioClips: [],
    assets: [{ id: "take", fileName: "take.mov", name: "Take", type: "video", duration: 12, url: "blob:take" }],
  });

test("half a second is a stretch short enough to listen to", async () => {
  project();
  const out = (await runAiTool("listen_audio", { asset_id: "take", to: 0.5 })) as { coveredTo: number; audio: string };
  expect(spans).toEqual([{ from: 0, to: 0.5 }]);
  expect(out.coveredTo).toBe(0.5);
  expect(out.audio.startsWith("data:audio/wav;base64,")).toBe(true);
});

test("a listen the connection drops says to wait for it and listen again", async () => {
  project();
  connection = "dropped";
  try {
    const error = await runAiTool("listen_audio", { asset_id: "take" }).then(() => "", (e: Error) => e.message);
    expect(error).toContain("Failed to fetch");
    expect(error).toContain("wait_for_uploads");
  } finally {
    connection = "up";
  }
});
