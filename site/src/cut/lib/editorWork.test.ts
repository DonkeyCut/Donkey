import { expect, test } from "bun:test";
import { editorIsLoading, holdEditorLoad, trackEditorTool } from "./editorWork";

test("a project load waits for an in-flight tool and holds new work", async () => {
  let finish!: () => void;
  const tool = trackEditorTool(() => new Promise<void>((resolve) => { finish = resolve; }));
  let entered = false;
  const load = holdEditorLoad().then((release) => { entered = true; return release; });
  await Promise.resolve();
  expect(entered).toBe(false);
  expect(editorIsLoading()).toBe(true);
  finish();
  await tool;
  const release = await load;
  expect(entered).toBe(true);
  release();
  expect(editorIsLoading()).toBe(false);
});

test("closing saves after active tools and holds the replacement load until saved", async () => {
  const { finishEditorWork } = await import("./editorWork");
  let finishTool!: () => void;
  let finishSave!: () => void;
  let saveStarted!: () => void;
  const saving = new Promise<void>((resolve) => { saveStarted = resolve; });
  const tool = trackEditorTool(() => new Promise<void>((resolve) => { finishTool = resolve; }));
  const close = finishEditorWork(async () => {
    saveStarted();
    await new Promise<void>((resolve) => { finishSave = resolve; });
  });
  let reopened = false;
  const load = holdEditorLoad().then((release) => { reopened = true; release(); });
  finishTool();
  await tool;
  await saving;
  expect(reopened).toBe(false);
  expect(editorIsLoading()).toBe(true);
  finishSave();
  await Promise.all([close, load]);
  expect(reopened).toBe(true);
  expect(editorIsLoading()).toBe(false);
});
