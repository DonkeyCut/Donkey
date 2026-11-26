import { expect, test } from "bun:test";
import { stubModule } from "@/lib/testing/stubModule";
import { AudioBuffer, OfflineAudioContext } from "node-web-audio-api";

// An export's mix decodes every heard span before the first frame draws, and
// over cloud media that read ran a minute with the export's bar held at 0%.
// The mix reports how far its decodes have reached, so the bar moves while
// the sound is read.
const RATE = 8000;

const globals = globalThis as Record<string, unknown>;
globals.AudioBuffer ??= AudioBuffer;
globals.OfflineAudioContext ??= OfflineAudioContext;

// Each span reports reaching its middle, then its end, the way a walk over a
// file reports each chunk it decodes.
await stubModule<typeof import("./mediaRead")>("./mediaRead", import.meta.url, {
  decodeAudioSpan: (async (_file: string, from: number, to: number, opts?: { onDecoded?: (until: number) => void }) => {
    opts?.onDecoded?.(from + (to - from) / 2);
    await Promise.resolve();
    opts?.onDecoded?.(to);
    return new AudioBuffer({ length: Math.max(1, Math.round((to - from) * RATE)), numberOfChannels: 1, sampleRate: RATE });
  }) as never,
});

const { renderMix } = await import("./audioMix");

test("the mix reports its decode from 0 to 1", async () => {
  const seen: number[] = [];
  await renderMix(
    {
      duration: 8,
      clips: [
        { file: "a.mp4", in: 0, out: 4, muted: false },
        { file: "b.mp4", in: 10, out: 14, muted: false },
      ],
      items: [],
    },
    { sampleRate: RATE, channels: 1, resolve: (f) => f, onProgress: (ratio) => seen.push(ratio) }
  );

  expect(seen.some((r) => r > 0 && r < 1)).toBe(true);
  expect(seen.every((r, i) => i === 0 || r >= seen[i - 1])).toBe(true);
  expect(seen.at(-1)).toBe(1);
});
