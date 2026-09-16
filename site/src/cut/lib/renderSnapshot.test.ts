import { expect, test } from "bun:test";
import { captureRenderSnapshot, type ExportDoc } from "./renderSnapshot";
import { projectOperation } from "./projectOperation";
import { browserBackend } from "./backend/browser";
import { sharedBackend } from "./backend/shared";
import { assertProjectCommand } from "./projectCommands";

const doc: ExportDoc = {
  aspect: "16:9", assets: [], clips: [], audioClips: [], overlays: [],
  subtitles: { cues: [], showOnVideo: false, showOnTimeline: false },
  background: "#000000",
};

test("render input remains unchanged after its source document is edited", () => {
  const source = structuredClone(doc);
  const operation = projectOperation("a", browserBackend);
  const snapshot = captureRenderSnapshot(operation, source);
  source.background = "#ffffff";
  source.subtitles.showOnVideo = true;
  expect(snapshot.doc.background).toBe("#000000");
  expect(snapshot.doc.subtitles.showOnVideo).toBe(false);
  expect(snapshot.operation.backend).toBe(browserBackend);
  expect(snapshot.revision).not.toBe(captureRenderSnapshot(operation, source).revision);
});

test("project commands reject a different project, a read-only share, and editor-only actions", () => {
  const operation = projectOperation("a", browserBackend);
  expect(() => assertProjectCommand(operation, "b", "split_clip")).toThrow("no longer open");
  expect(() => assertProjectCommand(operation, "a", "set_playing")).toThrow("editor interface");
  expect(() => projectOperation("a", sharedBackend)).toThrow("read-only");
  expect(() => assertProjectCommand(operation, "a", "split_clip")).not.toThrow();
});
