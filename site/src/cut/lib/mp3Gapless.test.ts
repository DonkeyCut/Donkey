import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { BufferSource, EncodedPacketSink, Input, MP3 } from "mediabunny";

// An MP3 opens with the encoder's delay plus the decoder's 529 samples of
// filter priming, and the LAME/Lavc tag in its Info frame says how many. The
// demuxer has to start the audio after them, the way ffmpeg does, or every MP3
// (the whole stock sound library) plays late in the tab and early in the
// engine's ffmpeg export. The fixture is 0.25 s of sine with delay 576.
const FIXTURE = new URL("./fixtures/sine-quarter-second.mp3", import.meta.url);
const RATE = 44_100;
const SKIP_SAMPLES = 576 + 529;

async function openFixture() {
  const bytes = readFileSync(FIXTURE);
  const input = new Input({ source: new BufferSource(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length)), formats: [MP3] });
  const track = await input.getPrimaryAudioTrack();
  if (!track) throw new Error("fixture has no audio");
  return { input, track };
}

describe("mp3 gapless start", () => {
  test("the first packet sits before zero by the tag's delay", async () => {
    const { input, track } = await openFixture();
    const first = await new EncodedPacketSink(track).getFirstPacket();
    expect(first?.timestamp).toBeCloseTo(-SKIP_SAMPLES / RATE, 6);
    input.dispose();
  });

  test("a packet looked up at zero is the one holding the first real sample", async () => {
    const { input, track } = await openFixture();
    const at = await new EncodedPacketSink(track).getPacket(0);
    expect(at).not.toBeNull();
    expect(at!.timestamp).toBeLessThanOrEqual(0);
    expect(at!.timestamp + at!.duration).toBeGreaterThan(0);
    input.dispose();
  });
});
