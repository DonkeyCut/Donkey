import { beforeEach, describe, expect, test } from "bun:test";
import { richDoc } from "./fixtures/richDoc";
import { canSplitItem, ITEM_KINDS, ITEM_KIND_IDS, type ItemKind, type ItemKindDef, type TimelineClipboardItem } from "./itemKinds";
import { mapTimelineItems, pasteTimelineItems, timelineFootprint, timelineItem } from "./timelineItems";
import { useEditor } from "./store";
import { runAiTool } from "./aiTools";
import { setPlayhead, setSkim } from "./playhead";
import type { Selection } from "./types";

const rich = richDoc();
const samples: TimelineClipboardItem[] = [
  { kind: "clip", item: rich.clips![1] },
  { kind: "audio", item: rich.audioClips![0] },
  ...rich.overlays!.map((item) => ({ kind: "overlay" as const, item: { ...item, groupId: undefined } })),
  { kind: "overlay", item: { id: "rect", kind: "shape", shape: "rect", start: 1, end: 3, x: 0.2, y: 0.4, w: 0.2, h: 0.2, fill: "#AA22DD", lane: 3 } },
  { kind: "cue", item: { ...rich.subtitles!.cues[0], words: [{ w: "hello", t0: 0.3, t1: 0.8 }] } },
  { kind: "transition", item: { ...rich.transitions![1], hidden: true } },
];
const s = () => useEditor.getState();
const def = (kind: ItemKind) => ITEM_KINDS[kind] as ItemKindDef<ItemKind>;
const selectionOf = (cb: TimelineClipboardItem): NonNullable<Selection> => ({ kind: cb.kind, id: cb.item.id });

beforeEach(() => {
  useEditor.setState({
    projectId: "operations", readOnly: false, loaded: true, playing: false,
    assets: rich.assets.map((a) => ({ ...a, url: "" })), clips: [], audioClips: [], overlays: [], transitions: [],
    subtitles: { ...rich.subtitles!, cues: [] }, selection: null, multiSelection: [], selectedKey: null,
  });
  for (const kind of ITEM_KIND_IDS) {
    const state = s();
    const next = def(kind).withList(state, samples.filter((cb) => cb.kind === kind).map((cb) => def(kind).clone(cb.item)));
    useEditor.setState({ ...next, subtitles: { ...state.subtitles, cues: next.subtitles.cues } });
  }
  setPlayhead(30);
  setSkim(null);
});

describe("shared timeline operations", () => {
  for (const sample of samples) {
    const label = `${sample.kind}:${sample.item.id}`;
    test(`${label}: copy, paste, move, delete and undo preserve properties`, () => {
      s().select(selectionOf(sample));
      const original = timelineItem(s(), selectionOf(sample))!;
      expect(s().copySelection()).toBe(true);
      expect(s().paste(30)).toBe(true);
      const selected = s().selection!;
      const pasted = timelineItem(s(), selected)!;
      expect(pasted).toEqual({ ...def(sample.kind).at(original, 30), id: pasted.id });
      expect(pasted.id).not.toBe(original.id);
      expect(pasted).not.toBe(original);
      const delta = s().moveTimelineSelection(3);
      expect(delta).toBe(3);
      expect(timelineItem(s(), selected)).toEqual(def(sample.kind).at(pasted, 33));
      s().undo();
      expect(timelineItem(s(), selected)).toEqual(pasted);
      s().select(selected);
      s().deleteSelection();
      expect(timelineItem(s(), selected)).toBeUndefined();
      expect(timelineItem(s(), selectionOf(sample))).toEqual(original);
      s().undo();
      expect(timelineItem(s(), selected)).toEqual(pasted);
      s().undo();
      expect(timelineItem(s(), selected)).toBeUndefined();
    });

    test(`${label}: split follows its declared capability`, () => {
      s().select(selectionOf(sample));
      const before = def(sample.kind).list(s()).length;
      const range = timelineFootprint(sample);
      s().splitAtPlayhead((range.start + range.end) / 2);
      expect(def(sample.kind).list(s()).length).toBe(before + (canSplitItem(sample.kind) ? 1 : 0));
    });
  }

  test("transition Split never falls through to underlying video or creates history", () => {
    const bar = s().transitions[0];
    s().select({ kind: "transition", id: bar.id });
    const before = s();
    s().splitAtPlayhead(10);
    expect(s().clips).toBe(before.clips);
    expect(s().transitions).toBe(before.transitions);
    expect(s()).toBe(before);
  });

  test("a mixed split leaves transitions whole and splits eligible selected items", () => {
    s().setMultiSelection(samples.map(selectionOf));
    const transitions = s().transitions;
    s().splitAtPlayhead(2);
    expect(s().transitions).toBe(transitions);
    expect(s().audioClips).toHaveLength(2);
    expect(s().overlays.length).toBeGreaterThan(samples.filter((cb) => cb.kind === "overlay").length);
  });

  test("copying a mixed set keeps offsets, fresh group identities and nested data", () => {
    s().setMultiSelection(samples.map(selectionOf));
    const group = s().groupSelection();
    s().copySelection();
    const copies = s().copiedItems();
    s().paste(40);
    const pasted = s().multiSelection.map((sel) => timelineItem(s(), sel!)!);
    const origin = Math.min(...copies.map((cb) => cb.item.start));
    pasted.forEach((item, i) => {
      expect(item.start).toBeCloseTo(40 + copies[i].item.start - origin);
      expect(item.groupId).not.toBe(group);
      expect(item.groupId).toBe(pasted[0].groupId);
    });
    const source = copies.find((cb) => "kf" in cb.item && cb.item.kf?.length)!.item;
    const keyed = pasted.find((item) => "kf" in item && item.kf?.length)!;
    if ("kf" in source && source.kf && "kf" in keyed && keyed.kf) {
      const x = source.kf[0].x;
      keyed.kf[0].x = 0.123;
      expect(source.kf[0].x).toBe(x);
    }

  });

  test("pasting on an occupied transition adds a copy beyond it", () => {
    const bar = s().transitions[0];
    s().select({ kind: "transition", id: bar.id });
    s().copySelection();
    s().paste(bar.start);
    expect(s().transitions).toHaveLength(2);
    expect(s().transitions[0]).toEqual(bar);
    expect(s().transitions[1].start).toBeCloseTo(bar.start + bar.seconds);
  });

  test("edits to one kind preserve untouched collection identities", () => {
    const state = s();
    const next = mapTimelineItems(state, [{ kind: "transition", id: state.transitions[0].id }], () => null);
    expect(next.clips).toBe(state.clips);
    expect(next.overlays).toBe(state.overlays);
    expect(next.audioClips).toBe(state.audioClips);
    expect(next.subtitles).toBe(state.subtitles);
    let n = 0;
    const pasted = pasteTimelineItems(state, [{ kind: "transition", item: state.transitions[0] }], 40, () => `id-${n++}`);
    expect(pasted.next.clips).toBe(state.clips);
  });

  test("chat can copy, paste and delete transitions; split is rejected", async () => {
    const bar = s().transitions[0];
    await runAiTool("select", { kind: "transition", id: bar.id });
    expect(await runAiTool("copy_selection", {})).toMatchObject({ copied: 1 });
    const result = await runAiTool("paste_selection", { at: 40 });
    expect(result).toMatchObject({ selection: s().multiSelection });
    expect(s().transitions).toHaveLength(2);
    const fresh = s().selection!;
    await expect(runAiTool("split_at", { t: 40.2 })).rejects.toThrow("Nothing to split");
    expect(s().transitions).toHaveLength(2);
    await runAiTool("delete_item", fresh);
    expect(s().transitions).toHaveLength(1);
  });
});
