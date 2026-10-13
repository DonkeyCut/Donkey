import { expect, test } from "bun:test";
import { stubModule } from "@/lib/testing/stubModule";

// The whole-video walk downloaded masters beside a play and took the link
// from the clips the play was opening. It now reads only while the cut is
// stopped and no clip spans are being read.
let releaseRead!: () => void;
await stubModule<typeof import("./mediaRead")>("./mediaRead", import.meta.url, {
  openMediaShared: (() => ({ input: {} as never, release: () => {} })) as never,
  videoTrackOf: (() => new Promise((resolve) => (releaseRead = () => resolve(null)))) as never,
});
const { useEditor, videoWalkGate } = await import("./store");
const { warmClipSpans } = await import("./spanWarm");

const tick = () => new Promise((r) => setTimeout(r, 10));

test("the walk holds while the cut plays and goes once it stops", async () => {
  useEditor.setState({ playing: true });
  let open = false;
  void videoWalkGate().then(() => (open = true));
  await tick();
  expect(open).toBe(false);
  useEditor.setState({ playing: false });
  await tick();
  expect(open).toBe(true);
});

test("the walk holds while clip spans are read and goes once they land", async () => {
  useEditor.setState({ playing: false });
  const reading = warmClipSpans([{ url: "https://m/a.mp4.light.mp4", from: 0, to: 0.5 }]);
  let open = false;
  void videoWalkGate().then(() => (open = true));
  await tick();
  expect(open).toBe(false);
  releaseRead();
  await reading;
  await tick();
  expect(open).toBe(true);
});
