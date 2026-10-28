import { afterAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  BlobSource,
  CustomVideoDecoder,
  type EncodedPacket,
  Input,
  MP4,
  registerDecoder,
  VideoSample,
  VideoSampleSink,
} from "mediabunny";

// mediabunny's decode pump, as patched (patches/mediabunny+1.61.0.patch):
// what happens to a decoder that fails while the reader has stopped pulling.

const CLIP = join(dirname(fileURLToPath(import.meta.url)), "../../../public/cut-starter/media/recap-01-6a6c904b.mp4");
const bytes = readFileSync(CLIP);

// Registered decoders are process-wide and permanent, so each answers only
// while a case of its own runs.
let active = false;
let closed = 0;
let steady = false;

/** A decoder that hands back a frame per packet and fails out of band a
 * moment after its fourth: by then the pump has filled the queue and is
 * parked waiting for the reader. */
class FailingDecoder extends CustomVideoDecoder {
  private n = 0;

  static override supports() {
    return active;
  }

  init() {}

  decode(packet: EncodedPacket) {
    this.onSample(
      new VideoSample(new Uint8Array(16), {
        format: "RGBX",
        codedWidth: 2,
        codedHeight: 2,
        timestamp: packet.timestamp,
        duration: packet.duration,
      })
    );
    if (++this.n === 4) {
      setTimeout(() => this.onError(new DOMException("Decoder failure", "EncodingError")), 20);
    }
  }

  flush() {}

  close() {
    closed++;
  }
}
registerDecoder(FailingDecoder);

/** Every frame a SteadyDecoder made, to check each was closed. */
const made: VideoSample[] = [];

/** A decoder that hands back a frame per packet and never fails. */
class SteadyDecoder extends CustomVideoDecoder {
  static override supports() {
    return steady;
  }

  init() {}

  decode(packet: EncodedPacket) {
    const sample = new VideoSample(new Uint8Array(16), {
      format: "RGBX",
      codedWidth: 2,
      codedHeight: 2,
      timestamp: packet.timestamp,
      duration: packet.duration,
    });
    made.push(sample);
    this.onSample(sample);
  }

  flush() {}

  close() {}
}
registerDecoder(SteadyDecoder);

afterAll(() => {
  active = false;
  steady = false;
});

/** Whether mediabunny has let a sample's frame go. */
const isClosed = (sample: VideoSample) => (sample as unknown as { _closed: boolean })._closed;

const settle = () => new Promise((r) => setTimeout(r, 60));

describe("decode pump", () => {
  const reads = {
    "a run of frames": (sink: VideoSampleSink) => sink.samples(),
    "frames at timestamps": (sink: VideoSampleSink) => sink.samplesAtTimestamps(Array.from({ length: 48 }, (_, i) => i / 24)),
  };

  for (const [name, read] of Object.entries(reads)) {
    test(`a decoder that fails mid-read is closed: ${name}`, async () => {
      active = true;
      closed = 0;
      const input = new Input({ source: new BlobSource(new Blob([bytes])), formats: [MP4] });
      try {
        const track = await input.getPrimaryVideoTrack();
        const samples = read(new VideoSampleSink(track!));

        // One frame read, then the reader stops while the pump fills up.
        (await samples.next()).value?.close();
        await settle();

        await expect(samples.next()).rejects.toThrow("Decoder failure");
        await settle();

        expect(closed).toBe(1);
      } finally {
        active = false;
        input.dispose();
      }
    });
  }

  for (const [name, read] of Object.entries(reads)) {
    test(`an input disposed under an idle reader closes what the pump queued: ${name}`, async () => {
      steady = true;
      made.length = 0;
      const input = new Input({ source: new BlobSource(new Blob([bytes])), formats: [MP4] });
      try {
        const track = await input.getPrimaryVideoTrack();
        const samples = read(new VideoSampleSink(track!));

        // One frame read, then the reader goes idle and never asks again
        // while the pump fills the queue and parks.
        (await samples.next()).value?.close();
        await settle();
        expect(made.length).toBeGreaterThan(1);

        input.dispose();
        await settle();

        expect(made.filter((sample) => !isClosed(sample))).toEqual([]);
      } finally {
        steady = false;
      }
    });
  }
});
