import { open, unlink } from "node:fs/promises";
import path from "node:path";
import { ALL_FORMATS, CustomSource, Input } from "mediabunny";
import { prepareSourceRemux, prepareTrimRemux } from "../lib/sourceRemux";
import type { SourceSegment } from "../lib/sourceExportPlan";
import { runFfmpeg, type RenderHandle } from "./exportPipeline";

/** The Mac and worker share the packet copier with browser exports. */
export async function exportSourceFiles(job: RenderHandle, resolve: (file: string) => string, segments: SourceSegment[], codec: "h264" | "hevc", audioBitrate?: number) {
  const inputs = new Map<string, Input>();
  const sources: Awaited<ReturnType<typeof open>>[] = [];
  const readers: Input[] = [];
  const scratch: string[] = [];
  const stop = () => { if (job.error) throw new Error(job.error); };
  const read = async (file: string) => {
    const source = await open(file, "r");
    sources.push(source);
    const input = new Input({ formats: ALL_FORMATS, source: new CustomSource({
      getSize: async () => (await source.stat()).size,
      read: async (start, end) => {
        const buffer = new Uint8Array(end - start);
        let filled = 0;
        while (filled < buffer.length) {
          stop();
          const { bytesRead } = await source.read(buffer, filled, buffer.length - filled, start + filled);
          if (!bytesRead) throw new Error("Source file ended during export.");
          filled += bytesRead;
        }
        return buffer;
      },
      maxCacheSize: 0,
    }) });
    readers.push(input);
    return input;
  };
  const write = async (copy: NonNullable<Awaited<ReturnType<typeof prepareSourceRemux>>>, file: string, progress: (ratio: number) => void) => {
    const target = await open(file, "w");
    try {
      await copy({
        write: async (data, position) => {
          let written = 0;
          while (written < data.length) {
            const { bytesWritten } = await target.write(data, written, data.length - written, position + written);
            if (!bytesWritten) throw new Error("Could not write source export.");
            written += bytesWritten;
          }
        },
        truncate: (size) => target.truncate(size),
      }, progress, stop);
    } finally { await target.close(); }
  };
  try {
    for (const segment of segments) if (!inputs.has(segment.file)) inputs.set(segment.file, await read(resolve(segment.file)));
    const audioTracks = await Promise.all(segments.map((s) => inputs.get(s.file)!.getPrimaryAudioTrack()));
    const reference = audioTracks.find(Boolean);
    const joinedAudio = segments.length > 1 && !!reference;
    const copy = await prepareSourceRemux(inputs, segments, codec, joinedAudio);
    if (!copy) return false;
    if (!joinedAudio) {
      await write(copy, job.outPath, (ratio) => { job.progress = ratio; });
      return true;
    }
    const videoPath = path.join(job.tmpDir, `source-video-${crypto.randomUUID()}.mp4`);
    const audioPath = path.join(job.tmpDir, `source-audio-${crypto.randomUUID()}.m4a`);
    scratch.push(videoPath, audioPath);
    await write(copy, videoPath, (ratio) => { job.progress = ratio * 0.3; });
    stop();
    const sampleRate = await reference!.getSampleRate();
    const channels = Math.max(...await Promise.all(audioTracks.map((track) => track?.getNumberOfChannels() ?? 0)));
    const filters = segments.map((s, index) => audioTracks[index]
      ? `[${index}:a:0]atrim=start=${s.from}:end=${s.to},asetpts=PTS-${s.from}/TB,aresample=${sampleRate}:async=1:first_pts=0,aformat=channel_layouts=${channels}c,apad,atrim=duration=${s.to - s.from}[a${index}]`
      : `anullsrc=r=${sampleRate}:cl=${channels}c,atrim=duration=${s.to - s.from}[a${index}]`);
    filters.push(`${segments.map((_, i) => `[a${i}]`).join("")}concat=n=${segments.length}:v=0:a=1[audio]`);
    const duration = segments.reduce((n, s) => n + s.to - s.from, 0);
    await runFfmpeg(job, ["-y", ...segments.flatMap((s) => ["-i", resolve(s.file)]),
      "-filter_complex", filters.join(";"), "-map", "[audio]", "-c:a", "aac",
      "-b:a", String(audioBitrate ?? 192_000), "-ar", String(sampleRate), "-ac", String(channels), "-t", String(duration), audioPath],
      (seconds) => { job.progress = 0.3 + Math.min(0.5, seconds / duration * 0.5); });
    stop();
    const joined = await prepareTrimRemux(await read(videoPath), { file: videoPath, from: 0, to: duration }, codec, await read(audioPath));
    if (!joined) throw new Error("Could not mux the source export audio.");
    await write(joined, job.outPath, (ratio) => { job.progress = 0.8 + ratio * 0.2; });
    return true;
  } finally {
    for (const input of readers) input.dispose();
    await Promise.all(sources.map((source) => source.close()));
    await Promise.all(scratch.map((file) => unlink(file).catch(() => {})));
  }
}
