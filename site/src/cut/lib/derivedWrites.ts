import { useEditor } from "./store";
import type { MediaAsset } from "./types";

/**
 * Filmstrips, waveforms and scene cuts land on the store in batches, once the
 * page goes idle.
 *
 * Every store write forces React into a blocking render of its own, and that
 * render throws away whatever lower-priority render React had under way. A
 * project opening with a few dozen clips answered a cached strip and a cached
 * waveform for each, every one in a task of its own, so React committed one
 * forced render after another with its own work still pending — and past fifty
 * in a row it refused the next write as an update loop (React error #185).
 * Queued here, those patches wait for an idle moment, which comes only once
 * React has finished its own work, and then land together as one render.
 */

/** Longest a queued patch waits for the page to go idle. A page that never
 * idles — a long play, a busy import — still gets its strips, a batch at a
 * time. */
const IDLE_TIMEOUT_MS = 500;

const queued = new Map<string, Partial<MediaAsset>>();
let scheduled = false;

/** Queue a filmstrip, waveform or scene-cut patch for an asset. A later
 * patch to the same field replaces the earlier one. */
export function landDerived(id: string, patch: Partial<MediaAsset>): void {
  queued.set(id, { ...queued.get(id), ...patch });
  if (scheduled) {
    return;
  }

  scheduled = true;
  whenIdle(flush);
}

/** The asset as it stands once its queued patches land: what a reader that
 * just queued a strip should see. */
export function liveAsset(id: string): MediaAsset | undefined {
  const asset = useEditor.getState().assets.find((a) => a.id === id);
  const patch = queued.get(id);
  return asset && patch ? { ...asset, ...patch } : asset;
}

// Land every queued patch in this one task: React renders the writes of one
// task together.
function flush(): void {
  scheduled = false;
  const batch = [...queued];
  queued.clear();
  const { updateAsset } = useEditor.getState();
  for (const [id, patch] of batch) {
    updateAsset(id, patch);
  }
}

// A runtime with no idle callbacks — the headless engine and worker — renders
// nothing, so the next task serves.
function whenIdle(fn: () => void): void {
  if (typeof requestIdleCallback === "function") {
    requestIdleCallback(fn, { timeout: IDLE_TIMEOUT_MS });
    return;
  }

  setTimeout(fn, 0);
}
