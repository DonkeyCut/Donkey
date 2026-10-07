import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { crc32, pcm24, planStems, wavBytes, wavChunks, writeStoredZip } from "./stems";
import { wavHeader } from "./wav";

const asset = (id: string, over: Record<string, unknown> = {}) => ({ id, type: "audio" as const, name: `${id}.mp3`, ...over });
const video = (id: string) => ({ id, type: "video" as const, name: `${id}.mp4` });

describe("stem plan", () => {
  test("the video clips' sound first, then one stem per soundtrack lane in lane order", () => {
    const stems = planStems({
      clips: [{ assetId: "v", muted: false }],
      audioClips: [
        { assetId: "song", lane: 1 },
        { assetId: "vo", lane: 0 },
      ],
      assets: [video("v"), asset("song", { beats: { beats: [1], bpm: 120 } }), asset("vo", { origin: "voiceover" })],
    });
    expect(stems).toEqual([
      { name: "Dialogue", lane: null, file: "1 Dialogue.wav" },
      { name: "Voiceover", lane: 0, file: "2 Voiceover.wav" },
      { name: "Music", lane: 1, file: "3 Music.wav" },
    ]);
  });

  test("a ducking clip reads as voiceover; a lane of one file takes its name; a mixed lane its number", () => {
    const stems = planStems({
      clips: [],
      audioClips: [
        { assetId: "take", lane: 0, duck: 0.3 },
        { assetId: "whoosh", lane: 2 },
        { assetId: "whoosh", lane: 2, name: "Swish" },
        { assetId: "a", lane: 3 },
        { assetId: "b", lane: 3 },
      ],
      assets: [asset("take"), asset("whoosh"), asset("a"), asset("b")],
    });
    expect(stems.map((s) => s.name)).toEqual(["Voiceover", "whoosh", "Audio 4"]);
  });

  test("nothing audible makes no stem: muted and hidden clips, stills, silent lanes", () => {
    const stems = planStems({
      clips: [{ assetId: "v", muted: true }, { assetId: "img", muted: false }, { assetId: "v", muted: false, hidden: true }],
      audioClips: [{ assetId: "a", hidden: true }],
      assets: [video("v"), { id: "img", type: "image", name: "still.png" }, asset("a")],
    });
    expect(stems).toEqual([]);
  });

  test("two lanes of music are told apart", () => {
    const beat = { beats: { beats: [1], bpm: 90 } };
    const stems = planStems({
      clips: [],
      audioClips: [{ assetId: "a", lane: 0 }, { assetId: "b", lane: 1 }],
      assets: [asset("a", beat), asset("b", beat)],
    });
    expect(stems.map((s) => s.file)).toEqual(["1 Music.wav", "2 Music 2.wav"]);
  });
});

describe("WAV", () => {
  test("a 24-bit header that counts its data", () => {
    const h = new DataView(wavHeader(48000, 2, 48000, 24).buffer);
    expect(h.getUint32(40, true)).toBe(48000 * 2 * 3);
    expect(h.getUint16(34, true)).toBe(24);
    expect(wavBytes(48000, 2)).toBe(44 + 48000 * 6);
  });

  test("samples interleave, clamp past full scale, and pad a short stem with silence", () => {
    const out = pcm24([Float32Array.from([1, -2]), Float32Array.from([0.5])], 0, 3, 2);
    const s = (i: number) => (out[i * 3] | (out[i * 3 + 1] << 8) | (out[i * 3 + 2] << 16)) << 8 >> 8;
    expect([s(0), s(1), s(2), s(3), s(4), s(5)]).toEqual([8388607, 4194304, -8388608, 0, 0, 0]);
  });
});

describe("stored zip", () => {
  test("CRC-32 matches the standard check value", () => {
    expect(crc32(new TextEncoder().encode("123456789"))).toBe(0xcbf43926);
  });

  test("unzip reads the archive back, every entry intact", async () => {
    const tone = Float32Array.from({ length: 4800 }, (_, i) => Math.sin(i / 10) * 0.5);
    const entries = [
      { name: "1 Dialogue.wav", channels: [tone, tone] },
      { name: "2 Music.wav", channels: [tone.map((v) => -v), tone] },
    ].map((e) => ({
      name: e.name,
      size: wavBytes(4800, 2),
      read: () => wavChunks(e.channels, 4800, 2, 48000),
    }));
    const chunks: Uint8Array[] = [];
    await writeStoredZip(entries, (b) => void chunks.push(b.slice()));
    const dir = mkdtempSync(path.join(os.tmpdir(), "stems-zip-"));
    try {
      const file = path.join(dir, "stems.zip");
      writeFileSync(file, Buffer.concat(chunks));
      const test = spawnSync("unzip", ["-t", file]);
      expect(test.status).toBe(0);
      const out = path.join(dir, "out");
      expect(spawnSync("unzip", ["-q", file, "-d", out]).status).toBe(0);
      const wav = readFileSync(path.join(out, "2 Music.wav"));
      expect(wav.length).toBe(wavBytes(4800, 2));
      expect(wav.subarray(0, 4).toString()).toBe("RIFF");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
