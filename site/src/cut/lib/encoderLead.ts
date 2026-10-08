/**
 * How far an audio encoder's output runs behind its input.
 *
 * An AAC encoder opens its stream with priming — 2112 samples from the one
 * this Mac's browser uses — and stamps that first packet 0, so the sound plays
 * that much late against the picture unless the file says to skip it. A file
 * says so with an edit list, and the muxer writes one when the audio starts
 * before zero: start the track at minus the lead, and the edit list trims
 * exactly the priming. The lead is the encoder's own, so it is measured here
 * once per format — a click encoded and decoded back — rather than assumed.
 */

import {
  AudioBufferSink,
  AudioBufferSource,
  BufferSource,
  BufferTarget,
  Input,
  MP4,
  Mp4OutputFormat,
  Output,
  type AudioCodec,
} from "mediabunny";

/** Where the probe's click sits, far enough in that any lead stays inside. */
const PROBE_CLICK_S = 0.1;
const PROBE_LENGTH_S = 0.4;

const leads = new Map<string, Promise<number>>();

/** Seconds the encoder's output trails its input; 0 for codecs with no
 * priming. Measured once per codec, rate and channel count. */
export function encoderLead(codec: AudioCodec, sampleRate: number, channels: number): Promise<number> {
  if (codec.startsWith("pcm")) return Promise.resolve(0);
  const key = `${codec}/${sampleRate}/${channels}`;
  let lead = leads.get(key);
  if (!lead) {
    lead = measureLead(codec, sampleRate, channels);
    // A probe that failed is asked again next time, not remembered.
    lead.catch(() => leads.delete(key));
    leads.set(key, lead);
  }
  return lead;
}

async function measureLead(codec: AudioCodec, sampleRate: number, channels: number): Promise<number> {
  // One sample of click in silence, through the same encoder the export uses.
  const length = Math.round(PROBE_LENGTH_S * sampleRate);
  const at = Math.round(PROBE_CLICK_S * sampleRate);
  const probe = new AudioBuffer({ length, numberOfChannels: channels, sampleRate });
  for (let ch = 0; ch < channels; ch++) probe.getChannelData(ch)[at] = 0.9;

  const target = new BufferTarget();
  const output = new Output({ format: new Mp4OutputFormat(), target });
  const source = new AudioBufferSource({ codec, bitrate: 192_000 });
  output.addAudioTrack(source);
  await output.start();
  await source.add(probe);
  await output.finalize();

  // Decode it back and find where the click came out.
  const input = new Input({ formats: [MP4], source: new BufferSource(target.buffer!) });
  try {
    const track = await input.getPrimaryAudioTrack();
    if (!track) throw new Error("The encoder probe wrote no audio.");
    let peak = 0;
    let peakAt = 0;
    for await (const { buffer, timestamp } of new AudioBufferSink(track).buffers()) {
      const data = buffer.getChannelData(0);
      for (let i = 0; i < data.length; i++) {
        if (Math.abs(data[i]) <= peak) continue;
        peak = Math.abs(data[i]);
        peakAt = timestamp + i / buffer.sampleRate;
      }
    }
    return Math.max(0, peakAt - at / sampleRate);
  } finally {
    input.dispose();
  }
}
