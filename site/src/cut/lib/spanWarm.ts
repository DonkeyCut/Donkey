"use client";

/**
 * The footage a cloud project's cut plays, read ahead of the playhead.
 *
 * A cut that changes file every half second opens a file every half second,
 * and an open that has to reach the network takes longer than the half second
 * the preview gives it (`PREROLL_LEAD_S`): every cold join stalls. The
 * whole-file prefetch (mediaSync.ts) gets there in the end, but it walks
 * masters front to back one file at a time, and a clip playing through its
 * proxy never reads its master at all. This reads exactly what each clip
 * plays — the container's index and the packets from the keyframe before its
 * in-point to its out-point — from the file the preview decodes
 * (`previewUrl`), in timeline order from the playhead, through the same chunk
 * cache the decoder reads. Nothing is decoded; the bytes land resident, so the
 * join opens off disk.
 */

import { EncodedPacketSink } from "mediabunny";
import { openMediaShared, videoTrackOf } from "./mediaRead";
import { previewUrl, type MediaAsset, type VideoClip } from "./types";

/** One clip's read: a span of source seconds in the file the preview plays. */
export interface WarmSpan {
  url: string;
  from: number;
  to: number;
}

/** Files read at once. One is too few to stay ahead of a fast cut over a slow
 * link; more starves the reads the playing decoder makes itself. */
const WARM_PARALLEL = 3;

/**
 * What to read, in order: the clips still to play from `at`, then the ones
 * before it, which a replay from the top plays next. A clip already under the
 * playhead goes first. A clip read twice — a file the cut returns to — is
 * listed once per use; the second read is a disk read.
 */
export function warmOrder(
  clips: Pick<VideoClip, "assetId" | "start" | "in" | "out" | "speed">[],
  assets: Pick<MediaAsset, "id" | "type" | "url" | "proxyUrl">[],
  at: number
): WarmSpan[] {
  const byId = new Map(assets.map((a) => [a.id, a]));
  const end = (c: (typeof clips)[number]) => c.start + Math.abs(c.out - c.in) / (c.speed || 1);
  const sorted = [...clips].sort((a, b) => a.start - b.start);
  const ahead = sorted.filter((c) => end(c) > at);
  const behind = sorted.filter((c) => end(c) <= at);
  return [...ahead, ...behind].flatMap((c) => {
    const asset = byId.get(c.assetId);
    if (!asset || asset.type !== "video") return [];
    const url = previewUrl(asset);
    return url ? [{ url, from: Math.min(c.in, c.out), to: Math.max(c.in, c.out) }] : [];
  });
}

/** Spans read to the end since the project opened, e.g. "url|4|4.5". A play
 * restarts the walk from the playhead, and the walk passes over these, so a
 * play costs only what is still unread. */
const warmed = new Set<string>();
const spanKey = (span: WarmSpan) => `${span.url}|${span.from}|${span.to}`;

/** Read one span's packets through the shared reader, so the index the
 * playing decoder parses next is the one this parsed. */
async function warmSpan(span: WarmSpan, signal: AbortSignal): Promise<void> {
  const handle = openMediaShared(span.url);
  try {
    const track = await videoTrackOf(handle.input);
    if (signal.aborted) return;
    if (track) {
      const sink = new EncodedPacketSink(track);
      let packet =
        (await sink.getKeyPacket(span.from, { verifyKeyPackets: true })) ?? (await sink.getFirstPacket());
      while (packet && packet.timestamp <= span.to && !signal.aborted) {
        packet = await sink.getNextPacket(packet);
      }
    }
    if (!signal.aborted) warmed.add(spanKey(span));
  } finally {
    handle.release();
  }
}

let running: AbortController | null = null;
let walk: Promise<void> | null = null;

/**
 * Read a project's clips ahead of `at`, cancelling any read already running —
 * a new play or a new project restarts the walk from where it now stands.
 * Resolves when every span has been read or the walk was cancelled. A span
 * that fails is left for the decoder's own read: this is only a head start.
 */
export function warmClipSpans(all: WarmSpan[]): Promise<void> {
  running?.abort();
  const ctrl = new AbortController();
  running = ctrl;
  const spans = all.filter((span) => !warmed.has(spanKey(span)));
  let next = 0;
  const lane = async () => {
    while (!ctrl.signal.aborted && next < spans.length) {
      const span = spans[next++];
      await warmSpan(span, ctrl.signal).catch(() => {});
    }
  };
  const done = Promise.all(Array.from({ length: WARM_PARALLEL }, lane)).then(() => {
    if (running === ctrl) running = null;
    if (walk === done) walk = null;
  });
  walk = done;
  return done;
}

/** Whether a walk is reading now. */
export const clipWarmBusy = (): boolean => walk !== null;

/** Resolves once no walk is reading: the one running now, and any a play
 * started in its place. What waits on this — the whole-file prefetch — never
 * shares the link with a walk the playhead depends on. */
export async function clipWarmSettled(): Promise<void> {
  while (walk) await walk;
}

/** Stop the walk, when the project closes. */
export function stopClipWarm(): void {
  running?.abort();
  running = null;
  walk = null;
  warmed.clear();
}
