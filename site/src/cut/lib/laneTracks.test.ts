import { beforeEach, describe, expect, test } from "bun:test";
import { commitRow, landOnRow, NEW_ROW_PX, partAround, resolveRow } from "./laneTracks";
import { clipLen, useEditor } from "./store";
import { emptySubtitles } from "./types";
import type { AudioClip, VideoClip } from "./types";

/**
 * One vertical model for every lane kind: the row under the pointer takes
 * the item, a reach past either edge of the band opens a new row, an
 * outermost row held alone offers nothing on its side, and a commit renumbers
 * lanes contiguous. Video and audio go through the same functions; the only
 * difference is which way the video stack counts its rows.
 */

let n = 0;
const vclip = (o: Partial<VideoClip>): VideoClip => ({
  id: `c${++n}`,
  assetId: "x",
  track: 0,
  start: 0,
  in: 0,
  out: 2,
  muted: false,
  ...o,
});
const aclip = (o: Partial<AudioClip>): AudioClip => ({
  id: `au${++n}`,
  assetId: "x",
  start: 0,
  in: 0,
  out: 2,
  volume: 1,
  ...o,
});
const s = () => useEditor.getState();
const clipById = (id: string) => s().clips.find((c) => c.id === id)!;
const audioById = (id: string) => s().audioClips.find((c) => c.id === id)!;

beforeEach(() => {
  useEditor.setState({
    clips: [],
    transitions: [],
    audioClips: [],
    overlays: [],
    subtitles: emptySubtitles(),
    selection: null,
    multiSelection: [],
  });
});

describe("resolveRow", () => {
  // Three rows of 40px stacked from y=100.
  const rows = [
    { top: 100, h: 40 },
    { top: 140, h: 40 },
    { top: 180, h: 40 },
  ];
  const open = { top: true, bottom: true };

  test("the row under the pointer takes the item", () => {
    expect(resolveRow(rows, 110, null, open)).toBe(0);
    expect(resolveRow(rows, 150, null, open)).toBe(1);
    expect(resolveRow(rows, 219, null, open)).toBe(2);
  });

  test("a pointer in the gap between rows takes the row below", () => {
    const gapped = [
      { top: 100, h: 40 },
      { top: 146, h: 40 },
    ];
    expect(resolveRow(gapped, 143, null, open)).toBe(1);
  });

  test("a new row opens only past the reach beyond either edge", () => {
    expect(resolveRow(rows, 100 - NEW_ROW_PX + 1, null, open)).toBe(0);
    expect(resolveRow(rows, 100 - NEW_ROW_PX - 1, null, open)).toBe(-1);
    expect(resolveRow(rows, 220 + NEW_ROW_PX - 1, null, open)).toBe(2);
    expect(resolveRow(rows, 220 + NEW_ROW_PX + 1, null, open)).toBe(3);
  });

  test("a held new row keeps its hold with no reach until the pointer returns to a row", () => {
    expect(resolveRow(rows, 99, -1, open)).toBe(-1);
    expect(resolveRow(rows, 101, -1, open)).toBe(0);
    expect(resolveRow(rows, 221, 3, open)).toBe(3);
    expect(resolveRow(rows, 219, 3, open)).toBe(2);
  });

  test("a closed edge offers no new row, however far the drag reaches", () => {
    expect(resolveRow(rows, 0, null, { top: false, bottom: true })).toBe(0);
    expect(resolveRow(rows, 400, null, { top: true, bottom: false })).toBe(2);
  });
});

describe("partAround", () => {
  const item = (id: string, start: number, len: number) => ({ view: { id, start, len, lane: 0 } });
  const rest = (x: { view: { start: number } }) => x.view.start;

  test("residents past the pointer slide right as one run", () => {
    const a = item("a", 1, 2);
    const b = item("b", 3, 2);
    const part = partAround([a, b], 1.2, 1.2, 2, rest);
    expect(part.slotStart).toBeCloseTo(1.2);
    expect(part.clamped).toBe(false);
    expect(part.at(a)).toBeCloseTo(3.2);
    expect(part.at(b)).toBeCloseTo(5.2);
  });

  test("a resident whose midpoint sits before the pointer holds, and clamps the slot after it", () => {
    const a = item("a", 0, 2);
    const part = partAround([a], 1.5, 0.5, 2, rest);
    expect(part.slotStart).toBeCloseTo(2);
    expect(part.clamped).toBe(true);
    expect(part.at(a)).toBe(0);
  });
});

describe("commitRow on the video stack", () => {
  test("the row past the top opens a new highest track", () => {
    const spine = vclip({ track: 0 });
    const layer = vclip({ track: 1 });
    const mover = vclip({ track: 0, start: 2 });
    useEditor.setState({ clips: [spine, layer, mover] });
    commitRow("video", mover.id, -1);
    expect(clipById(mover.id).track).toBe(2);
    expect(clipById(layer.id).track).toBe(1);
    expect(clipById(spine.id).track).toBe(0);
  });

  test("the row past the bottom makes the clip the new track 0 and renumbers the stack", () => {
    const spine = vclip({ track: 0 });
    const mover = vclip({ track: 1 });
    const anchor = vclip({ track: 1, start: 3 });
    useEditor.setState({ clips: [spine, mover, anchor] });
    commitRow("video", mover.id, 2);
    expect(clipById(mover.id).track).toBe(0);
    expect(clipById(spine.id).track).toBe(1);
    expect(clipById(anchor.id).track).toBe(2);
  });

  test("a row in the stack is the track drawn there", () => {
    const spine = vclip({ track: 0 });
    const layer = vclip({ track: 1 });
    const mover = vclip({ track: 0, start: 2 });
    useEditor.setState({ clips: [spine, layer, mover] });
    commitRow("video", mover.id, 0);
    expect(clipById(mover.id).track).toBe(1);
  });

  test("the only track-0 clip moving up grounds the stack", () => {
    const mover = vclip({ track: 0 });
    const resident = vclip({ track: 1, start: 3 });
    useEditor.setState({ clips: [mover, resident] });
    commitRow("video", mover.id, 0);
    expect(clipById(mover.id).track).toBe(0);
    expect(clipById(resident.id).track).toBe(0);
  });
});

describe("landOnRow on the audio lanes", () => {
  // What the store's add does with the lane it is handed: 0 is stored as none.
  const land = (_row: number, lane: number) => {
    const c = aclip({ start: 5, ...(lane > 0 ? { lane } : {}) });
    useEditor.setState({ audioClips: [...s().audioClips, c] });
    return c.id;
  };

  test("a row in use lands on that lane", () => {
    const bed = aclip({});
    const fx = aclip({ lane: 1 });
    useEditor.setState({ audioClips: [bed, fx] });
    let id = "";
    landOnRow("audio", 1, (lane) => (id = land(1, lane)));
    expect(audioById(id).lane).toBe(1);
    expect(audioById(bed.id).lane).toBeUndefined();
  });

  test("the row past the top opens a new first lane, the way a drag does", () => {
    const bed = aclip({});
    const fx = aclip({ lane: 1 });
    useEditor.setState({ audioClips: [bed, fx] });
    let id = "";
    landOnRow("audio", -1, (lane) => (id = land(-1, lane)));
    expect(audioById(id).lane).toBeUndefined();
    expect(audioById(bed.id).lane).toBe(1);
    expect(audioById(fx.id).lane).toBe(2);
  });

  test("the row past the bottom opens a new last lane", () => {
    const bed = aclip({});
    useEditor.setState({ audioClips: [bed] });
    let id = "";
    landOnRow("audio", 1, (lane) => (id = land(1, lane)));
    expect(audioById(id).lane).toBe(1);
    expect(audioById(bed.id).lane).toBeUndefined();
  });

  test("an empty band lands on lane 0", () => {
    useEditor.setState({ audioClips: [] });
    let id = "";
    landOnRow("audio", 0, (lane) => (id = land(0, lane)));
    expect(audioById(id).lane).toBeUndefined();
  });
});

describe("commitRow on the audio lanes", () => {
  test("the row past the top opens a new first lane", () => {
    const bed = aclip({});
    const fx = aclip({ lane: 1 });
    useEditor.setState({ audioClips: [bed, fx] });
    commitRow("audio", fx.id, -1);
    expect(audioById(fx.id).lane).toBeUndefined();
    expect(audioById(bed.id).lane).toBe(1);
  });

  test("the row past the bottom opens a new last lane", () => {
    const bed = aclip({});
    const fx = aclip({ start: 3 });
    useEditor.setState({ audioClips: [bed, fx] });
    commitRow("audio", fx.id, 1);
    expect(audioById(fx.id).lane).toBe(1);
    expect(audioById(bed.id).lane).toBeUndefined();
  });

  test("an emptied lane collapses", () => {
    const a = aclip({});
    const b = aclip({ lane: 1 });
    const c = aclip({ lane: 2 });
    useEditor.setState({ audioClips: [a, b, c] });
    commitRow("audio", b.id, 0);
    expect(audioById(b.id).lane).toBeUndefined();
    expect(audioById(c.id).lane).toBe(1);
  });
});

describe("a cross-row move keeps the lane sound", () => {
  test("landing among residents parts them and the commit takes the row", () => {
    const mover = vclip({ track: 0, start: 0, out: 2 });
    const anchor = vclip({ track: 0, start: 2, out: 2 });
    const resident = vclip({ track: 1, start: 1, out: 2 });
    useEditor.setState({ clips: [mover, anchor, resident] });
    const st = s();
    const view = (c: VideoClip) => ({ view: { id: c.id, start: c.start, len: clipLen(c), lane: c.track } });
    const part = partAround([view(resident)], 1.2, 1.2, 2, (x) => x.view.start);
    st.updateClipsTransient([
      { id: mover.id, patch: { start: part.slotStart } },
      { id: resident.id, patch: { start: part.at(view(resident)) } },
    ]);
    commitRow("video", mover.id, 0);
    expect(clipById(mover.id).track).toBe(1);
    expect(clipById(mover.id).start).toBeCloseTo(1.2);
    expect(clipById(resident.id).start).toBeCloseTo(3.2);
  });
});
