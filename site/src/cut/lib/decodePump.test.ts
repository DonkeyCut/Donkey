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

const CLIP = join(dirname(fileURLToPath(import.meta.url)), "../../../public/cut-starter/media/ai-watercolor-and-loose-black-ink-sketch-il-1.mp4");
const bytes = readFileSync(CLIP);

// Registered decoders are process-wide and permanent, so this one answers
// only while a case here runs.
let active = false;
let closed = 0;

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

afterAll(() => {
  active = false;
});

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
});
