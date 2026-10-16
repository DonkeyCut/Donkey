import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { makeCompatProxy, makeProxy, probeProxySource, proxyFfmpegArgs, proxyMatrixOf, proxyNameFor } from "./proxy";
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
    // A keyframe every second: the preview seeks into the proxy at every
    // cut, and a seek decodes from the keyframe before it.
    expect(args[args.indexOf("-force_key_frames") + 1]).toBe("expr:if(isnan(prev_forced_t),1,gte(t,prev_forced_t+1))");

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

  test("keyframes fall a second apart from the first frame, whatever time the master starts at", () => {
    const source = { matrix: "bt709" as const, fullRange: false, height: 1080, hasAudio: false };
    const args = proxyFfmpegArgs("in.ts", "out.mp4", { encoder: "libx265", source, maxHeight: 1080, crf: 20 });
    // With -copyts, t is the master's own timestamp: counting forced frames
    // against it made every frame a keyframe on a file starting at 1000 s.
    expect(args[args.indexOf("-force_key_frames") + 1]).toBe("expr:if(isnan(prev_forced_t),1,gte(t,prev_forced_t+1))");
  });

  test("a light proxy holds a bitrate ceiling in either encoder", () => {
    const source = { matrix: "bt709" as const, fullRange: false, height: 2160, hasAudio: false };
    const x265 = proxyFfmpegArgs("in.mp4", "out.mp4", { encoder: "libx265", source, maxHeight: 1080, crf: 20, maxKbps: 6000 });
    expect(x265.join(" ")).toContain("-maxrate 6000k -bufsize 6000k");
    const vt = proxyFfmpegArgs("in.mp4", "out.mp4", { encoder: "hevc_videotoolbox", source, maxHeight: 1080, crf: 20, maxKbps: 6000 });
    expect(vt.join(" ")).toContain("-b:v 6000k");
    expect(vt).not.toContain("-q:v");
    // A ProRes proxy keeps its quality target and no ceiling.
    expect(proxyFfmpegArgs("in.mp4", "out.mp4", { encoder: "libx265", source, maxHeight: 1080, crf: 20 })).not.toContain("-maxrate");
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

describe("compat proxy", () => {
  /** Codec names of `file`'s streams, video first. */
  const codecsOf = (file: string) =>
    ffprobe(["-show_entries", "stream=codec_type,codec_name", "-of", "csv=p=0", file]).trim().split("\n").sort();
  /** A one-second phone-like clip: H.264 High picture, AAC sound. */
  const phoneClip = (name: string, colour: string[] = []) => {
    const src = path.join(dir, name);
    ffmpeg(["-y", "-f", "lavfi", "-i", "testsrc=size=320x240:rate=24:duration=1", "-f", "lavfi", "-i", "sine=duration=1",
      "-c:v", "libx264", "-pix_fmt", "yuv420p", ...colour, "-c:a", "aac", "-shortest", src]);
    return src;
  };

  test("a browser without H.264 gets VP9 picture and Opus sound in WebM", async () => {
    const src = phoneClip("phone.mp4");
    const out = path.join(dir, "phone.mp4.compat.webm");
    await makeCompatProxy(handle(out), src, out, { cover: "video", maxHeight: 180, crf: 20 });

    expect(codecsOf(out)).toEqual(["opus,audio", "vp9,video"]);
    expect(ffprobe(["-show_entries", "format=format_name", "-of", "csv=p=0", out])).toContain("webm");
    expect(Number(ffprobe(["-select_streams", "v", "-show_entries", "stream=height", "-of", "csv=p=0", out]))).toBe(180);
  }, 60_000);

  test("a Rec.709 picture is copied when only the sound needs Opus", async () => {
    const src = phoneClip("rec709.mp4", ["-colorspace", "bt709", "-color_range", "tv"]);
    const out = path.join(dir, "rec709.mp4.compat.mp4");
    await makeCompatProxy(handle(out), src, out, { cover: "audio", maxHeight: 1080, crf: 20 });

    expect(codecsOf(out)).toEqual(["h264,video", "opus,audio"]);
    const packets = (file: string) => ffprobe(["-select_streams", "v", "-show_entries", "packet=size", "-of", "csv=p=0", file]);
    expect(packets(out)).toBe(packets(src));
  }, 60_000);

  test("a Rec.709 picture MP4 can't hold is encoded when only the sound needs Opus", async () => {
    const src = path.join(dir, "master.mov");
    ffmpeg(["-y", "-f", "lavfi", "-i", "testsrc=size=320x240:rate=24:duration=1", "-f", "lavfi", "-i", "sine=duration=1",
      "-c:v", "prores_ks", "-colorspace", "bt709", "-color_range", "tv", "-c:a", "aac", "-shortest", src]);
    const out = path.join(dir, "master.mov.compat.mp4");
    await makeCompatProxy(handle(out), src, out, { cover: "audio", maxHeight: 1080, crf: 20 });

    expect(codecsOf(out)).toEqual(["h264,video", "opus,audio"]);
  }, 60_000);

  test("a picture outside Rec.709 limited is carried into it", async () => {
    const src = phoneClip("fullrange.mp4", ["-colorspace", "smpte170m", "-color_range", "pc"]);
    const out = path.join(dir, "fullrange.mp4.compat.mp4");
    await makeCompatProxy(handle(out), src, out, { cover: "audio", maxHeight: 1080, crf: 20 });

    expect(codecsOf(out)).toEqual(["h264,video", "opus,audio"]);
    expect(ffprobe(["-select_streams", "v", "-show_entries", "stream=color_space,color_range", "-of", "csv=p=0", out]).trim()).toBe("tv,bt709");
  }, 60_000);

  test("an audio file gets Opus sound alone", async () => {
    const src = path.join(dir, "voice.m4a");
    ffmpeg(["-y", "-f", "lavfi", "-i", "sine=duration=1", "-c:a", "aac", src]);
    const out = path.join(dir, "voice.m4a.compat.mp4");
    await makeCompatProxy(handle(out), src, out, { cover: "audio", maxHeight: 1080, crf: 20 });

    expect(codecsOf(out)).toEqual(["opus,audio"]);
  }, 60_000);
});
