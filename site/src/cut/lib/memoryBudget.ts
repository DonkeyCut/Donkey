/**
 * What the editor is allowed to hold in memory, and what it is holding.
 *
 * A cut is built out of expensive pictures. Decoded frames sit in the
 * platform decoder, canvases sit behind every source the pool keeps warm, and
 * the bytes of the files themselves sit in each reader's cache. Every one of
 * those is capped somewhere, but the caps were written one subsystem at a
 * time, in whatever currency that subsystem thinks in — a count of decoders, a
 * number of source pixels, a number of canvas pixels, a number of open files.
 * Nothing added them up, so the tab's real ceiling was whatever those numbers
 * happened to sum to on the machine the change was tuned on.
 *
 * This is the one place the total is decided. Holders register what they are
 * standing on, in bytes, and ask what they may stand on: the smaller of the
 * size they were tuned to want and their share of the tab's ceiling. On a
 * machine with memory to spare the tuned size is the smaller one and nothing
 * about the preview changes. On a machine without, the share binds first and
 * every holder sheds together, so no one subsystem eats the room the others
 * needed.
 *
 * The ceiling is a model. The memory that actually runs a machine out is
 * memory a page cannot see: decoded frames live in the platform's decoder
 * process, canvas backing lives in the GPU process, and
 * `measureUserAgentSpecificMemory` — which needs a cross-origin isolation this
 * page does not have — reports the size of neither. So the accounting is done
 * at the allocation sites, where the sizes are known exactly.
 */

/** Where the tab's memory goes. Each is a family of allocations with one
 * eviction story, so a bucket is what a share can sensibly be given to. */
export type MemoryBucket =
  /** Frames held inside the platform decoder, on behalf of live decoders. */
  | "decoders"
  /** Canvas backing: the rings frames land on, and the warm shelf. */
  | "canvases"
  /** File bytes held by open readers. */
  | "reads"
  /** Decoded sound waiting to be scheduled. */
  | "audio"
  /** Rasterized pictures: element bitmaps, thumbnails, mattes. */
  | "pictures";

const BUCKETS: MemoryBucket[] = ["decoders", "canvases", "reads", "audio", "pictures"];

/**
 * Each bucket's share of the ceiling.
 *
 * The split follows what the buckets actually cost at the sizes people edit
 * at: a live 4K decoder holds hundreds of megabytes of frames where the
 * canvases drawn from it hold tens, and the readers under both hold the file
 * bytes those frames were decoded from. The shares sum to one, and a bucket
 * holding less than its share does not lend the remainder — a holder that
 * grows into borrowed room has to give it back mid-gesture, which is the churn
 * the caps exist to prevent.
 */
const SHARES: Record<MemoryBucket, number> = {
  decoders: 0.4,
  canvases: 0.25,
  reads: 0.25,
  audio: 0.05,
  pictures: 0.05,
};

/**
 * The tab's share of the machine.
 *
 * A quarter of what the browser reports leaves the operating system, the
 * browser's own processes and the person's other tabs the rest. Past that the
 * machine starts swapping, and a swapping machine previews worse than one
 * decoding at half the size — the picture stops for a page fault, which no
 * amount of decode headroom recovers.
 */
const CEILING_SHARE = 0.25;
/**
 * What to assume when the browser does not say.
 *
 * `deviceMemory` is Chrome and Edge only; Safari and Firefox report nothing.
 * Eight is also the largest number Chrome will report, so it already means
 * "eight or more" — assuming it for the browsers that stay silent puts them
 * on the same footing as the machines we can see, which are overwhelmingly
 * the same machines.
 */
const ASSUMED_GB = 8;
/** The smallest ceiling worth honouring: below this the editor cannot hold a
 * single 1080p source open, so a machine reporting less memory still gets this
 * much. */
const CEILING_MIN = 384 * 2 ** 20;

const GB = 2 ** 30;

let ceiling = 0;

/**
 * Bytes the editor may hold, decided once.
 *
 * `deviceMemory` is coarse by design — it rounds to a power of two and caps at
 * eight — which is enough to tell the machines that need protecting from the
 * machines that do not, and it is the only figure a page is given.
 */
export function memoryCeiling(): number {
  if (ceiling) return ceiling;
  const reported =
    typeof navigator === "undefined"
      ? 0
      : ((navigator as unknown as { deviceMemory?: number }).deviceMemory ?? 0);
  const gb = reported > 0 ? reported : ASSUMED_GB;
  ceiling = Math.max(CEILING_MIN, Math.round(gb * GB * CEILING_SHARE));
  return ceiling;
}

/** Bytes a holder in `bucket` may stand on: the smaller of the size it was
 * tuned to want and its share of the ceiling. */
export function allowance(bucket: MemoryBucket, tuned: number): number {
  const share = Math.round(memoryCeiling() * SHARES[bucket]);
  if (share < tuned) bound[bucket] = true;
  return Math.min(tuned, share);
}

/** Buckets whose share came in under what they were tuned to want: the
 * ceiling is deciding their size. Read and cleared by whoever is reporting;
 * it says the machine is the constraint. */
const bound: Record<MemoryBucket, boolean> = {
  decoders: false,
  canvases: false,
  reads: false,
  audio: false,
  pictures: false,
};

/** Which buckets the ceiling is currently deciding the size of, clearing the
 * record. */
export function takeMemoryPressure(): MemoryBucket[] {
  const hit = BUCKETS.filter((b) => bound[b]);
  for (const b of hit) bound[b] = false;
  return hit;
}

type Reporter = () => number;

const holders = new Map<MemoryBucket, Set<Reporter>>();

/**
 * Say what a cache is standing on, so the total can be reported.
 *
 * Reporters are pulled: a cache that has to remember to announce every
 * allocation eventually forgets one, and the number it forgot is the number a
 * report needs. Returns the way to stop reporting.
 */
export function holdMemory(bucket: MemoryBucket, bytes: Reporter): () => void {
  let set = holders.get(bucket);
  if (!set) holders.set(bucket, (set = new Set()));
  set.add(bytes);
  return () => {
    set.delete(bytes);
  };
}

export type MemoryUsage = Record<MemoryBucket, number> & { total: number };

/** What every registered cache is holding right now, by bucket. */
export function memoryUsage(): MemoryUsage {
  const out = { decoders: 0, canvases: 0, reads: 0, audio: 0, pictures: 0, total: 0 };
  for (const bucket of BUCKETS) {
    let n = 0;
    for (const bytes of holders.get(bucket) ?? []) n += bytes();
    out[bucket] = n;
    out.total += n;
  }
  return out;
}

/** Least time between two walks of every reporter, for callers that want a
 * number rather than a peak. */
const TOTAL_TTL_MS = 1_000;
let totalAt = 0;
let total = 0;

/**
 * What everything is holding, from a walk no more than a second old.
 *
 * Reading the total walks every cache that reports one. A caller on a path
 * that is already in trouble — the record of a frame that blocked — wants the
 * number without paying that walk again for a figure that cannot have moved
 * far since the last one.
 */
export function memoryTotalCached(): number {
  const now = Date.now();
  if (now - totalAt >= TOTAL_TTL_MS) {
    totalAt = now;
    total = memoryUsage().total;
  }
  return total;
}

/**
 * The JavaScript heap, where a browser reports one.
 *
 * It is a small part of what an editor holds — the pictures are all outside it
 * — and Chrome quantizes what it returns. It is worth reporting anyway: a heap
 * climbing across a session is the signature of a cache that never evicts,
 * which the modeled numbers beside it cannot show.
 */
export function heapBytes(): number {
  const perf = typeof performance === "undefined" ? null : performance;
  const mem = (perf as unknown as { memory?: { usedJSHeapSize?: number } } | null)?.memory;
  return mem?.usedJSHeapSize ?? 0;
}

const MB = 2 ** 20;

/** Bytes as whole megabytes, which is the resolution every report of this
 * wants. */
export const mb = (bytes: number): number => Math.round(bytes / MB);

/** Four bytes a pixel: the canvas backing behind a picture of that size. */
export const canvasBytes = (pixels: number): number => pixels * 4;

/**
 * A decoded frame of a picture that size.
 *
 * Hardware decoders hand back planar 4:2:0 — a full-resolution luma plane and
 * two quarter-resolution chroma planes — which is where the three halves come
 * from. A frame drawn at a smaller size still costs this: the decode happens
 * at the file's own resolution and the scaling happens after.
 */
export const decodedFrameBytes = (pixels: number): number => Math.round(pixels * 1.5);
