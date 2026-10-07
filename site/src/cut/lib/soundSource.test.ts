import { describe, expect, test } from "bun:test";

import { spanSoundSpec, spanUsesSoundFeature } from "./soundSource";
import type { ClipSpan, MediaAsset, VideoClip } from "./types";

/**
 * What a clip's sound asks of a renderer: the spec entry that carries a bound
 * recording and a split edit, and whether the clip needs a renderer that
 * plays either at all.
 */

const asset = (id: string, type: MediaAsset["type"]): MediaAsset => ({
  id,
  fileName: `${id}.bin`,
  name: id,
  type,
  duration: 30,
  url: "",
});
const span = (a: MediaAsset, extra: Partial<ClipSpan> = {}, clip: Partial<VideoClip> = {}): ClipSpan => ({
  clip: { id: "c", assetId: a.id, in: 0, out: 5, start: 0, track: 0, ...clip } as VideoClip,
  asset: a,
  start: 0,
  len: 5,
  transitionOut: 0,
  soundOut: 0,
  soundAhead: 0,
  soundBack: 0,
  ...extra,
});

describe("spanSoundSpec", () => {
  test("carries the bound recording by the spec's file name and fills a split edit's missing side", () => {
    const rec = asset("r", "audio");
    const spec = spanSoundSpec(span(asset("v", "video"), { sound: { asset: rec, offset: 0.5, limit: 30 }, soundLead: 1 }), (a) => `f-${a.id}`);
    expect(spec).toEqual({
      soundFrom: { file: "f-r", offset: 0.5, duration: 30 },
      soundLead: 1,
      soundTail: 0,
      splitFade: 0,
    });
  });

  test("a clip on its own track with no split edit adds nothing", () => {
    expect(spanSoundSpec(span(asset("v", "video")), (a) => a.fileName)).toEqual({});
  });
});

describe("spanUsesSoundFeature", () => {
  test("a split edit or a bound recording on a clip that sounds", () => {
    expect(spanUsesSoundFeature(span(asset("v", "video"), { soundLead: 1 }))).toBe(true);
    expect(spanUsesSoundFeature(span(asset("v", "video"), { sound: { asset: asset("r", "audio"), offset: 0, limit: 30 } }))).toBe(true);
    expect(spanUsesSoundFeature(span(asset("v", "video")))).toBe(false);
  });

  test("a leftover split edit on a clip that plays nothing asks nothing", () => {
    expect(spanUsesSoundFeature(span(asset("i", "image"), { soundLead: 1 }))).toBe(false);
    expect(spanUsesSoundFeature(span(asset("v", "video"), { soundTail: 1 }, { muted: true }))).toBe(false);
    expect(spanUsesSoundFeature(span(asset("v", "video"), { soundTail: 1 }, { hidden: true }))).toBe(false);
  });
});
