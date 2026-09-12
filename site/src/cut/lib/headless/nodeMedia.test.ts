import { expect, spyOn, test } from "bun:test";
import { VideoSampleSink, type VideoSample } from "mediabunny";
import { NodeFrameSink } from "./nodeMedia";

test("a headless transform failure closes its source sample", async () => {
  const failure = new Error("Transform failed");
  let closed = 0;
  const sample = { transform: async () => { throw failure; }, close: () => { closed++; } } as unknown as VideoSample;
  const getSample = spyOn(VideoSampleSink.prototype, "getSample").mockResolvedValue(sample);
  // Only the sink's sample source is replaced; getCanvas runs the real ownership path.
  const sink = Object.create(NodeFrameSink.prototype) as NodeFrameSink;
  Object.assign(sink, { samples: Object.create(VideoSampleSink.prototype) });
  try {
    await expect(sink.getCanvas(0)).rejects.toBe(failure);
    expect(closed).toBe(1);
  } finally { getSample.mockRestore(); }
});
