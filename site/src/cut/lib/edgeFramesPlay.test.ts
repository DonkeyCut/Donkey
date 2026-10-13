import { expect, test } from "bun:test";
import { stubModule } from "@/lib/testing/stubModule";

// The timeline follows the playhead while the cut plays, and every clip the
// scroll brings into view asks for its edge frames. Those reads opened each
// clip's file just as the play opened it, and on a fast cut they took the
// link from the picture. An edge capture now waits until the play stops.
const opened: string[] = [];
await stubModule<typeof import("./mediaRead")>("./mediaRead", import.meta.url, {
  openMediaShared: ((url: string) => {
    opened.push(url);
    return { input: {} as never, release: () => {} };
  }) as never,
  videoTrackOf: (async () => null) as never,
});
const { requestEdgeFrame } = await import("./media");
const { useEditor } = await import("./store");

const tick = () => new Promise((r) => setTimeout(r, 10));

test("an edge capture asked for during a play opens nothing until it stops", async () => {
  useEditor.setState({ playing: true });
  const landed = requestEdgeFrame("clip:head", "https://m/a.mp4.light.mp4", 1);
  await tick();
  expect(opened).toEqual([]);
  useEditor.setState({ playing: false });
  expect(await landed).toBeNull();
  expect(opened).toEqual(["https://m/a.mp4.light.mp4"]);
});
