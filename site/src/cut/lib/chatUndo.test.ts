import { beforeEach, expect, test } from "bun:test";

import { runAiTool } from "./aiTools";
import { useEditor } from "./store";
import { emptySubtitles } from "./types";

// A chat turn is one undo step for ⌘Z, but the chat's own `undo` takes back
// one tool call: blocks, then the soundtrack, then a text run, and an undo of
// the text run leaves the blocks and the soundtrack where they are.

const s = () => useEditor.getState();

beforeEach(() => {
  // Close any batch a failed test left open.
  for (let i = 0; i < 4; i++) s().endHistoryBatch();
  useEditor.setState({
    projectId: "p1",
    loaded: true,
    aspect: "16:9",
    assets: [],
    clips: [],
    transitions: [],
    audioClips: [],
    overlays: [],
    subtitles: emptySubtitles(),
    selection: null,
    multiSelection: [],
    background: "#000000",
  });
});

test("the chat's undo takes back its last tool call, not the turn", async () => {
  s().beginHistoryBatch();
  try {
    await runAiTool("add_clip", { blocks: [{ seconds: 1, color: "#ff0000" }, { seconds: 1, color: "#00ff00" }] });
    await runAiTool("add_shape", { shape: "rect", start: 0, end: 2, lane: 3 });
    await runAiTool("add_text_sequence", { lines: [{ text: "ONE", start: 0, end: 1 }, { text: "TWO", start: 1, end: 2 }] });
    expect(s().clips.length).toBe(2);
    expect(s().overlays.length).toBeGreaterThan(2);

    const out = (await runAiTool("undo", {})) as { reverted: string };
    expect(s().clips.length).toBe(2);
    expect(s().overlays.length).toBe(1);
    expect(out.reverted).toContain("add_text_sequence");

    const again = (await runAiTool("undo", {})) as { reverted: string };
    expect(s().clips.length).toBe(2);
    expect(s().overlays.length).toBe(0);
    expect(again.reverted).toContain("add_shape");

    const back = (await runAiTool("redo", {})) as { restored: string };
    expect(s().overlays.length).toBe(1);
    expect(back.restored).toContain("add_shape");
  } finally {
    s().endHistoryBatch();
  }
  // The person's ⌘Z after the turn still takes the whole turn back at once.
  expect(s().undo()).toBe(true);
  expect(s().clips.length).toBe(0);
  expect(s().overlays.length).toBe(0);
});

test("a tool call outside a chat turn is one undo step however many writes it makes", async () => {
  await runAiTool("add_shape", { shape: "rect", start: 0, end: 2, lane: 3 });
  await runAiTool("add_text_sequence", { lines: [{ text: "ONE", start: 0, end: 1 }, { text: "TWO", start: 1, end: 2 }] });
  const out = (await runAiTool("undo", {})) as { reverted: string };
  expect(s().overlays.length).toBe(1);
  expect(out.reverted).toContain("add_text_sequence");
});

test("a read leaves no undo step of its own", async () => {
  s().beginHistoryBatch();
  try {
    await runAiTool("add_shape", { shape: "rect", start: 0, end: 2, lane: 3 });
    await runAiTool("get_state", {});
    const out = (await runAiTool("undo", {})) as { reverted: string };
    expect(out.reverted).toContain("add_shape");
    expect(s().overlays.length).toBe(0);
  } finally {
    s().endHistoryBatch();
  }
});

test("an undo past the turn's first call takes back the turn before, and says so", async () => {
  s().beginHistoryBatch("chat turn");
  await runAiTool("add_shape", { shape: "rect", start: 0, end: 2, lane: 3 });
  s().endHistoryBatch();
  s().beginHistoryBatch("chat turn");
  try {
    await runAiTool("add_shape", { shape: "rect", start: 2, end: 4, lane: 3 });
    await runAiTool("undo", {});
    expect(s().overlays.length).toBe(1);
    const out = (await runAiTool("undo", {})) as { reverted: string; changes: string };
    expect(s().overlays.length).toBe(0);
    expect(out.reverted).toContain("earlier chat turn");
    expect(out.changes).toBe("1 element removed");
  } finally {
    s().endHistoryBatch();
  }
});

test("a tool still running when its turn stops leaves the person's next edit its own undo step", async () => {
  s().beginHistoryBatch("chat turn");
  // The call opens its step and writes, then settles after the turn stops.
  const call = runAiTool("add_shape", { shape: "rect", start: 0, end: 2, lane: 3 });
  s().endHistoryBatch();
  s().addOverlay();
  expect(s().overlays.length).toBe(2);
  await call;

  // ⌘Z takes back the person's title alone; the stopped turn's shape stays.
  expect(s().undo()).toBe(true);
  expect(s().overlays.length).toBe(1);
  expect(s().undo()).toBe(true);
  expect(s().overlays.length).toBe(0);
});

test("two threads' turns at once each record their tool calls as steps", async () => {
  s().beginHistoryBatch("chat turn");
  s().beginHistoryBatch("chat turn");
  try {
    await runAiTool("add_shape", { shape: "rect", start: 0, end: 2, lane: 3 });
    await runAiTool("add_shape", { shape: "rect", start: 2, end: 4, lane: 3 });
    const out = (await runAiTool("undo", {})) as { reverted: string };
    expect(out.reverted).toContain("add_shape");
    expect(s().overlays.length).toBe(1);
  } finally {
    s().endHistoryBatch();
    s().endHistoryBatch();
  }
  // Once both close, ⌘Z takes the two turns back as the one run they shared.
  expect(s().undo()).toBe(true);
  expect(s().overlays.length).toBe(0);
});
