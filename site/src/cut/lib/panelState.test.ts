import { beforeEach, expect, test } from "bun:test";
import { PANEL_GLOBAL, panelState, usePanelStore } from "./panelState";
import { useEditor } from "./store";
import type { AudioClip, Overlay, VideoClip } from "./types";

const clip = (id: string) => ({ id, assetId: "a", in: 0, out: 1 }) as unknown as VideoClip;

beforeEach(() => {
  usePanelStore.setState({ items: {} });
  useEditor.setState({ projectId: "p1", clips: [clip("c1"), clip("c2")], audioClips: [], overlays: [] });
});

test("a field holds per item and falls back to its default", () => {
  panelState.set("c1", "tab", "color");
  expect(panelState.get("c1", "tab", "main")).toBe("color");
  expect(panelState.get("c2", "tab", "main")).toBe("main");
  expect(panelState.get<boolean | null>("c1", "maskLinked", null)).toBeNull();
});

test("writing the same value again leaves the store untouched", () => {
  panelState.set("c1", "tab", "color");
  const before = usePanelStore.getState().items;
  panelState.set("c1", "tab", "color");
  expect(usePanelStore.getState().items).toBe(before);
});

test("a deleted item takes its memory with it; the rest stays", () => {
  panelState.set("c1", "tab", "color");
  panelState.set("c2", "tab", "audio");
  panelState.set(PANEL_GLOBAL, "subtitlesTab", "styles");
  useEditor.setState({ clips: [clip("c2")] });
  expect(usePanelStore.getState().items.c1).toBeUndefined();
  expect(panelState.get("c2", "tab", "main")).toBe("audio");
  expect(panelState.get(PANEL_GLOBAL, "subtitlesTab", "content")).toBe("styles");
});

test("an edit that keeps the element count never sweeps", () => {
  panelState.set("c1", "tab", "color");
  useEditor.setState({ clips: [clip("c1"), clip("c3")] });
  expect(panelState.get("c1", "tab", "main")).toBe("color");
});

test("switching projects drops every item of the old one", () => {
  panelState.set("c1", "speedCurve", true);
  useEditor.setState({
    projectId: "p2",
    clips: [],
    audioClips: [{ id: "m1" } as unknown as AudioClip],
    overlays: [{ id: "o1" } as unknown as Overlay],
  });
  expect(usePanelStore.getState().items.c1).toBeUndefined();
  panelState.set("o1", "animSlot", "out");
  expect(panelState.get("o1", "animSlot", "in")).toBe("out");
});
