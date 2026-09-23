import {
  EncodedAudioPacketSource, EncodedPacketSink, EncodedVideoPacketSource,
  Mp4OutputFormat, Output, StreamTarget, type Input, type EncodedPacket, type InputVideoTrack, type InputAudioTrack, type Rotation,
} from "mediabunny";
import type { SourceSegment } from "@/cut/lib/sourceExportPlan";

// MP4 edits express the playback window while keeping the dependency frames
// around each cut. The mdat stays on disk; only the movie index is rewritten.
type Box = { type: string; bytes: Uint8Array };
function boxes(bytes: Uint8Array, start = 8): Box[] {
  const result: Box[] = [];
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let at = start; at < bytes.length;) {
    const size = view.getUint32(at);
    if (size < 8 || at + size > bytes.length) throw new Error("Invalid MP4 movie index.");
    result.push({ type: String.fromCharCode(...bytes.subarray(at + 4, at + 8)), bytes: bytes.slice(at, at + size) });
    at += size;
  }
  return result;
}
function box(type: string, children: Uint8Array[]): Uint8Array {
  const bytes = new Uint8Array(8 + children.reduce((n, b) => n + b.length, 0));
  new DataView(bytes.buffer).setUint32(0, bytes.length);
  bytes.set(new TextEncoder().encode(type), 4);
  let at = 8;
  for (const child of children) { bytes.set(child, at); at += child.length; }
  return bytes;
}
function timeScale(bytes: Uint8Array): number {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(bytes[8] === 1 ? 28 : 20);
}
function setDuration(bytes: Uint8Array, ticks: number, track = false) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const offset = bytes[8] === 1 ? (track ? 36 : 32) : (track ? 28 : 24);
  if (bytes[8] === 1) view.setBigUint64(offset, BigInt(Math.round(ticks)));
  else view.setUint32(offset, Math.round(ticks));
}

/** Rebuild the terminal moov; all media offsets remain unchanged. */
export function trimMovieIndex(bytes: Uint8Array, offsets: number[], duration: number): Uint8Array {
  const children = boxes(bytes);
  const header = children.find((b) => b.type === "mvhd");
  if (!header) throw new Error("MP4 has no movie header.");
  const movieScale = timeScale(header.bytes);
  setDuration(header.bytes, duration * movieScale);
  let index = 0;
  return box("moov", children.map((child) => {
    if (child.type !== "trak") return child.bytes;
    const offset = offsets[index++];
    const track = boxes(child.bytes).filter((b) => b.type !== "edts");
    const tkhd = track.find((b) => b.type === "tkhd");
    const mdia = track.find((b) => b.type === "mdia");
    const mdhd = mdia && boxes(mdia.bytes).find((b) => b.type === "mdhd");
    if (!tkhd || !mdhd || offset === undefined) throw new Error("Invalid MP4 trim track.");
    setDuration(tkhd.bytes, duration * movieScale, true);
    // Version 1 stores both the segment duration and media time in 64 bits.
    const edit = new Uint8Array(28);
    const view = new DataView(edit.buffer);
    edit[0] = 1;
    view.setUint32(4, 1);
    view.setBigUint64(8, BigInt(Math.round(duration * movieScale)));
    view.setBigInt64(16, BigInt(Math.round(offset * timeScale(mdhd.bytes))));
    view.setUint16(24, 1);
    return box("trak", [...track.map((b) => b.bytes), box("edts", [box("elst", [edit])])]);
  }));
}

export type SourceWriter = {
  write(data: Uint8Array, position: number): Promise<void>;
  truncate(size: number): Promise<void>;
};

/** A codec-compatible copy needs neither a decoder nor an encoder. */
export async function prepareTrimRemux(input: Input, trim: SourceSegment, codec: "h264" | "hevc", audioInput: Input = input) {
  if (!Number.isFinite(trim.from) || !Number.isFinite(trim.to) || trim.from < 0 || trim.to <= trim.from) {
    throw new Error("Invalid source trim range.");
  }
  const video = await input.getPrimaryVideoTrack();
  const audio = await audioInput.getPrimaryAudioTrack();
  if (!video || await video.getCodec() !== (codec === "h264" ? "avc" : "hevc") ||
      (audio && await audio.getCodec() !== "aac")) return null;
  const videoSink = new EncodedPacketSink(video);
  const firstVideo = await videoSink.getKeyPacket(trim.from, { verifyKeyPackets: true });
  if (!firstVideo) return null;
  const audioSink = audio && new EncodedPacketSink(audio);
  const audioAtStart = audioSink && await audioSink.getPacket(trim.from);
  // AAC overlap needs the preceding packets to reconstruct the first samples.
  const audioPreroll = audioAtStart ? audioAtStart.timestamp - 2 * audioAtStart.duration : 0;
  const firstAudio = audioSink && (audioPreroll > 0
    ? await audioSink.getPacket(audioPreroll)
    : await audioSink.getFirstPacket());
  // Delayed audio needs an empty edit; let the compositor handle that case.
  if (audio && (!firstAudio || firstAudio.timestamp > trim.from)) return null;
  const videoConfig = await video.getDecoderConfig();
  const audioConfig = audio && await audio.getDecoderConfig();
  if (!videoConfig || (audio && !audioConfig)) return null;
  const rotation = await video.getRotation();
  return async (writer: SourceWriter, progress: (ratio: number) => void, stop: () => void) => {
    let movie: { bytes: Uint8Array; position: number } | undefined;
    const output = new Output({
      format: new Mp4OutputFormat({ fastStart: false, onMoov: (bytes, position) => { movie = { bytes, position }; } }),
      target: new StreamTarget(new WritableStream({ write: ({ data, position }) => writer.write(data, position) }), { chunked: true }),
    });
    const videoOut = new EncodedVideoPacketSource(codec === "h264" ? "avc" : "hevc");
    output.addVideoTrack(videoOut, { rotation });
    const audioOut = audio && firstAudio ? new EncodedAudioPacketSource("aac") : null;
    if (audioOut) output.addAudioTrack(audioOut);
    const offsets = [trim.from - firstVideo.timestamp];
    if (firstAudio && audioOut) offsets.push(trim.from - firstAudio.timestamp);
    const videos = videoSink.packets(firstVideo, undefined, { verifyKeyPackets: true });
    const audios = audioSink && firstAudio ? audioSink.packets(firstAudio) : null;
    try {
      stop();
      await output.start();
      let v = await videos.next();
      let a = audios ? await audios.next() : null;
      while (!v.done || (a && !a.done)) {
        stop();
        // The final GOP includes references needed by reordered B-frames.
        if (!v.done && v.value.type === "key" && v.value.timestamp >= trim.to) {
          await videos.return();
          v = { done: true, value: undefined };
        }
        if (a && !a.done && a.value.timestamp >= trim.to) {
          await audios!.return();
          a = null;
        }
        // Interleave reads as well as writes, keeping only one packet per track.
        if (!v.done && (!a || a.done || v.value.timestamp <= a.value.timestamp)) {
          const packet = v.value;
          // Reference frames beyond the playback end retain their bytes with
          // zero presentation duration. Packet-based readers then see the same
          // end as players honoring the edit list.
          await videoOut.add(packet.clone({ timestamp: Math.min(packet.timestamp, trim.to) - firstVideo.timestamp, duration: Math.max(0, Math.min(packet.duration, trim.to - packet.timestamp)) }), { decoderConfig: videoConfig });
          progress(Math.max(0, Math.min(0.99, (packet.timestamp - trim.from) / (trim.to - trim.from))));
          v = await videos.next();
        } else if (a && !a.done && audioOut && audioConfig && firstAudio) {
          await audioOut.add(a.value.clone({ timestamp: a.value.timestamp - firstAudio.timestamp, duration: Math.min(a.value.duration, trim.to - a.value.timestamp) }), { decoderConfig: audioConfig });
          a = await audios!.next();
        }
      }
      videoOut.close();
      audioOut?.close();
      stop();
      await output.finalize();
      if (!movie) throw new Error("Trim export produced no movie index.");
      const edited = trimMovieIndex(movie.bytes, offsets, trim.to - trim.from);
      await writer.write(edited, movie.position);
      await writer.truncate(movie.position + edited.length);
      progress(1);
    } catch (error) {
      await output.cancel().catch(() => {});
      throw error;
    } finally {
      await videos.return();
      await audios?.return();
    }
  };
}

/** Copy compatible picture sequences; joins encode sound independently. */
export async function prepareSourceRemux(inputs: Map<string, Input>, segments: SourceSegment[], codec: "h264" | "hevc", omitAudio = false) {
  if (segments.length === 1) return prepareTrimRemux(inputs.get(segments[0].file)!, segments[0], codec);
  if (!segments.length) return null;
  const tracks: { segment: SourceSegment; video: InputVideoTrack; audio: InputAudioTrack | null; sink: EncodedPacketSink; first: EncodedPacket; config: VideoDecoderConfig; rotation: Rotation; signature: string }[] = [];
  for (const segment of segments) {
    if (!(segment.from >= 0 && segment.to > segment.from && Number.isFinite(segment.to))) throw new Error("Invalid source export range.");
    const input = inputs.get(segment.file)!;
    const video = await input.getPrimaryVideoTrack();
    const audio = await input.getPrimaryAudioTrack();
    if (!video || await video.getCodec() !== (codec === "h264" ? "avc" : "hevc")) return null;
    const sink = new EncodedPacketSink(video);
    const first = await sink.getKeyPacket(segment.from, { verifyKeyPackets: true });
    const config = await video.getDecoderConfig();
    if (!first || !config) return null;
    const rotation = await video.getRotation();
    const bytes = config.description;
    const description = bytes ? Array.from(new Uint8Array(ArrayBuffer.isView(bytes) ? bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) : bytes)) : [];
    const signature = JSON.stringify({ ...config, description, rotation });
    if (tracks.length && (signature !== tracks[0].signature || Math.abs(first.timestamp - segment.from) > 0.000001)) return null;
    if (tracks.length < segments.length - 1) {
      const endKey = await sink.getKeyPacket(segment.to, { verifyKeyPackets: true });
      const duration = await video.computeDuration();
      if (Math.abs((endKey?.timestamp ?? -1) - segment.to) > 0.000001 && Math.abs(duration - segment.to) > 0.0001) return null;
    }
    tracks.push({ segment, video, audio, sink, first, config, rotation, signature });
  }
  // WebCodecs exposes no reliable AAC encoder priming; exact joins use the
  // machine's audio encoder while this path copies the video packets.
  if (!omitAudio && tracks.some((t) => t.audio)) return null;
  const duration = segments.reduce((n, s) => n + s.to - s.from, 0);
  const preroll = segments[0].from - tracks[0].first.timestamp;
  return async (writer: SourceWriter, progress: (ratio: number) => void, stop: () => void) => {
    let movie: { bytes: Uint8Array; position: number } | undefined;
    const output = new Output({
      format: new Mp4OutputFormat({ fastStart: false, onMoov: (bytes, position) => { movie = { bytes, position }; } }),
      target: new StreamTarget(new WritableStream({ write: ({ data, position }) => writer.write(data, position) }), { chunked: true }),
    });
    const videoOut = new EncodedVideoPacketSource(codec === "h264" ? "avc" : "hevc");
    output.addVideoTrack(videoOut, { rotation: tracks[0].rotation });
    async function* videoPackets(): AsyncGenerator<EncodedPacket> {
      let start = 0;
      for (const { segment, sink, first } of tracks) {
        for await (const packet of sink.packets(first, undefined, { verifyKeyPackets: true })) {
          stop();
          if (packet.type === "key" && packet.timestamp >= segment.to) break;
          yield packet.clone({ timestamp: start + preroll + Math.min(packet.timestamp, segment.to) - segment.from,
            duration: Math.max(0, Math.min(packet.duration, segment.to - packet.timestamp)) });
        }
        start += segment.to - segment.from;
      }
    }
    const videos = videoPackets();
    try {
      stop();
      await output.start();
      for await (const packet of videos) {
        stop();
        await videoOut.add(packet, { decoderConfig: tracks[0].config });
        progress(Math.max(0, Math.min(0.99, (packet.timestamp - preroll) / duration)));
      }
      videoOut.close();
      await output.finalize();
      stop();
      if (!movie) throw new Error("Source export produced no movie index.");
      const edited = trimMovieIndex(movie.bytes, [preroll], duration);
      await writer.write(edited, movie.position); await writer.truncate(movie.position + edited.length);
      progress(1);
    } catch (error) { await output.cancel().catch(() => {}); throw error; }
    finally { await videos.return(undefined); }
  };
}
