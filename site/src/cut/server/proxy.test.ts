import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { makeProxy, probeProxySource, proxyFfmpegArgs, proxyMatrixOf, proxyNameFor } from "./proxy";
import { openMedia, probeMediaFile, videoTrackOf } from "@/cut/lib/mediaRead";

const FIXTURE = path.join(path.dirname(fileURLToPath(import.meta.url)), "../lib/fixtures/prores-422hq-10bit.mov");

let dir: string;
beforeAll(async () => { dir = await mkdtemp(path.join(os.tmpdir(), "cut-proxy-test-")); });
afterAll(async () => { await rm(dir, { recursive: true, force: true }); });
const handle = (out: string) => ({ tmpDir: dir, outPath: out, progress: 0, log: [] as string[] });
const ffprobe = (args: string[]) =>
  execFileSync("ffprobe", ["-v", "error", ...args], { timeout: 30_000 }).toString();
const ffmpeg = (args: string[]) =>
  execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", ...args], { timeout: 30_000 });

/** The RGB of the fixture's flat picture as ffmpeg decodes `file` through
 * `matrix`, 16 bits per channel. */
function rgbThrough(file: string, matrix: string): number[] {
  const raw = ffmpeg([
    "-i", file, "-frames:v", "1",
    "-vf", `scale=in_color_matrix=${matrix}:in_range=tv:out_range=pc,format=gbrp16le,crop=1:1:32:32`,
    "-f", "rawvideo", "-pix_fmt", "rgb48le", "-",
  ]);
  return [raw.readUInt16LE(0), raw.readUInt16LE(2), raw.readUInt16LE(4)];
}

describe("proxy", () => {
  test("names the proxy beside its master", () => {
    expect(proxyNameFor("IMG_4450.MOV")).toBe("IMG_4450.proxy.mp4");
    expect(proxyNameFor("clip")).toBe("clip.proxy.mp4");
  });

  test("reads the master's matrix from ffprobe's names, untagged as Rec.709", () => {
    expect(proxyMatrixOf("bt2020nc")).toBe("bt2020nc");
    expect(proxyMatrixOf("smpte170m")).toBe("bt601");
    expect(proxyMatrixOf("bt709")).toBe("bt709");
    expect(proxyMatrixOf(undefined)).toBe("bt709");
  });

  test("builds the graph: master matrix in, Rec.709 limited out, 10-bit, tagged, timestamps kept", () => {
    const args = proxyFfmpegArgs("in.mov", "out.mp4", {
      encoder: "libx265",
      source: { matrix: "bt2020nc", fullRange: false, height: 2160, hasAudio: true },
      maxHeight: 1080,
      crf: 18,
    });
    const graph = args[args.indexOf("-vf") + 1];
    expect(graph).toBe(
      "scale=in_color_matrix=bt2020:in_range=tv:out_range=pc:w=-2:h=1080,format=gbrp16le," +
        "scale=out_color_matrix=bt709:out_range=tv,format=yuv420p10le," +
        "setparams=color_primaries=bt709:color_trc=iec61966-2-1:colorspace=bt709:range=tv"
    );
    expect(args.slice(0, 4)).toEqual(["-y", "-copyts", "-i", "in.mov"]);
    expect(args).toContain("-crf");
    expect(args[args.indexOf("-crf") + 1]).toBe("18");
    expect(args[args.indexOf("-profile:v") + 1]).toBe("main10");
    expect(args[args.indexOf("-c:a") + 1]).toBe("aac");
    expect(args[args.indexOf("-movflags") + 1]).toBe("+faststart");

    const vt = proxyFfmpegArgs("in.mov", "out.mp4", {
      encoder: "hevc_videotoolbox",
      source: { matrix: "bt709", fullRange: true, height: 1080, hasAudio: false },
      maxHeight: 2160,
      crf: 18,
    });
    const vtGraph = vt[vt.indexOf("-vf") + 1];
    expect(vtGraph.startsWith("scale=in_color_matrix=bt709:in_range=pc:out_range=pc,")).toBe(true);
    expect(vtGraph).toContain("format=p010le");
    expect(vt).not.toContain("-c:a");
    expect(vt).not.toContain("0:a:0");
    expect(vt[vt.indexOf("-c:v") + 1]).toBe("hevc_videotoolbox");
  });

  test("reads the fixture as a 10-bit BT.2020 ProRes master with sound", async () => {
    expect(await probeProxySource(FIXTURE)).toEqual({ matrix: "bt2020nc", fullRange: false, height: 64, hasAudio: true });
  });

  test("makes a Rec.709-tagged Main10 proxy whose RGB and timestamps match the master", async () => {
    const out = path.join(dir, "fixture.proxy.mp4");
    const outcome = await makeProxy(handle(out), FIXTURE, out, { maxHeight: 2160, crf: 18 });
    expect(outcome).toMatchObject({ width: 64, height: 64 });
    expect(outcome.sizeBytes).toBeGreaterThan(0);

    const stream = ffprobe([
      "-select_streams", "v:0",
      "-show_entries", "stream=codec_name,profile,pix_fmt,color_space,color_range,color_primaries,color_transfer,codec_tag_string",
      "-of", "json", out,
    ]);
    expect(JSON.parse(stream).streams[0]).toMatchObject({
      codec_name: "hevc",
      profile: "Main 10",
      pix_fmt: "yuv420p10le",
      color_space: "bt709",
      color_range: "tv",
      color_primaries: "bt709",
      color_transfer: "iec61966-2-1",
      codec_tag_string: "hvc1",
    });
    expect(ffprobe(["-select_streams", "a:0", "-show_entries", "stream=codec_name", "-of", "csv=p=0", out]).trim()).toBe("aac");

    // The same picture: the master through its own matrix, the proxy
    // through Rec.709, within a 10-bit code value at 16-bit scale.
    const master = rgbThrough(FIXTURE, "bt2020");
    const proxy = rgbThrough(out, "bt709");
    for (let c = 0; c < 3; c++) expect(Math.abs(master[c] - proxy[c])).toBeLessThan(96);
    // And unmistakably a different picture through the wrong matrix.
    const wrong = rgbThrough(out, "bt2020");
    expect(Math.max(...wrong.map((v, c) => Math.abs(v - master[c])))).toBeGreaterThan(400);

    // Frame N of the proxy sits where frame N of the master sits, as the
    // page's reader sees both.
    const firstOf = async (file: string) => {
      const input = openMedia(new Blob([await readFile(file)]));
      try {
        const track = await videoTrackOf(input);
        return track!.getFirstTimestamp();
      } finally {
        input.dispose();
      }
    };
    expect(await firstOf(out)).toBeCloseTo(await firstOf(FIXTURE), 3);
    expect((await probeMediaFile(new Blob([await readFile(out)]))).duration).toBeCloseTo(
      (await probeMediaFile(new Blob([await readFile(FIXTURE)]))).duration,
      1
    );

    // faststart: the index rides ahead of the samples.
    const bytes = await readFile(out);
    expect(bytes.indexOf("moov")).toBeLessThan(bytes.indexOf("mdat"));
  }, 60_000);
});
