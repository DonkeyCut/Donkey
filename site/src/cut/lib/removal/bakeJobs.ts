"use client";

/**
 * Matte bake jobs: one running bake per clip, keyed by clip id.
 *
 * `ensureMatteBake` is idempotent — the panel and the doc sweep call it
 * whenever an AI-mode removal is on, and the store compares the clip's
 * fingerprint against the stored matte and the bake in flight, so it only
 * ever starts work the doc actually owes. Every rung starts from an explicit
 * ask: `requested` (the panel's Apply, or the chat tool) starts auto mode's
 * free on-device matte, the hosted quality pass (credits) replaces it once
 * `refine` asks for it, and custom mode goes straight to the hosted tracker
 * (only it can follow a brushed object). A finished bake lands as a project
 * asset (origin "matte") and repoints `clip.removal.matte` through a
 * transient write: background landings stay off the undo stack, and the clip
 * change still marks the doc for saving.
 */

import { create } from "zustand";
import { importFileToProject } from "../media";
import { useEditor } from "../store";
import { removalFingerprint, type ClipRemoval, type VideoClip } from "../types";
import { useBrushUi } from "./brushUi";
import { hostedBakeMatte, type HostedBakeTicket } from "./hostedBake";
import { localBakeMatte, MatteBakeCancelled } from "./localBake";

type MatteQuality = "local" | "hq";

export interface MatteBakeJob {
  quality: MatteQuality;
  status: "running" | "error";
  /** 0..1 while running. */
  progress: number;
  /** Estimated seconds to done, from the run's own pace — stamped with each
   * progress step, absent until the estimate has anything to stand on. */
  secondsLeft?: number;
  /** When secondsLeft was stamped, so the panel counts it down between
   * progress steps. */
  etaAt?: number;
  /** When the bake started, so the panel shows the running time while the
   * estimate has nothing to stand on yet. */
  startedAt?: number;
  error?: string;
}

interface MatteBakes {
  jobs: Record<string, MatteBakeJob>;
}

export const useMatteBakes = create<MatteBakes>(() => ({ jobs: {} }));

/** Whether this surface can run bakes at all. Bakes decode and encode
 * through browser media machinery, so a headless turn writes the removal and
 * leaves the bake to the next editor session — the doc sweep starts it on
 * load, since the clip's fingerprint still owes a matte. */
export const matteBakesAvailable = typeof window !== "undefined";

const setJob = (clipId: string, job: MatteBakeJob | null) =>
  useMatteBakes.setState((s) => {
    const jobs = { ...s.jobs };
    if (job) jobs[clipId] = job;
    else delete jobs[clipId];
    return { jobs };
  });

/** The in-flight bake per clip: what it's baking, and its kill switch. */
const running = new Map<string, { fp: string; quality: MatteQuality; ctl: AbortController }>();

// The hosted bake bills at submit, so its poll ticket persists per browser: a
// reload re-attaches to the paid track through it and pays nothing new. One
// record per clip. A ticket outlives cancellation and failure — clearing a
// cutout and undoing it comes back to the same fingerprint, and the undo
// resumes the paid track; a dead track forgets only its own part inside the
// run. Landing drops the record; the sweep retires the rest: a changed
// selection, a clip gone from the doc, or plain age.
const TICKETS_KEY = "cut-matte-bake-tickets";
const TICKET_TTL_MS = 48 * 60 * 60 * 1000;
type PersistedTicket = {
  projectId: string;
  clipId: string;
  fp: string;
  gen: HostedBakeTicket;
  /** When the submit happened; absent on records from before the stamp. */
  at?: number;
};

function readTickets(): PersistedTicket[] {
  try {
    const v = JSON.parse(localStorage.getItem(TICKETS_KEY) ?? "[]") as unknown;
    return Array.isArray(v) ? (v as PersistedTicket[]) : [];
  } catch {
    return [];
  }
}

function writeTickets(tickets: PersistedTicket[]): void {
  try {
    localStorage.setItem(TICKETS_KEY, JSON.stringify(tickets));
  } catch {
    // Storage full/blocked — the resume convenience just won't persist.
  }
}

function saveTicket(ticket: PersistedTicket): void {
  writeTickets([
    ...readTickets().filter((t) => t.clipId !== ticket.clipId),
    { ...ticket, at: Date.now() },
  ]);
}

function dropTicket(clipId: string): void {
  const held = readTickets();
  const rest = held.filter((t) => t.clipId !== clipId);
  if (rest.length !== held.length) writeTickets(rest);
}

/** The persisted in-flight track for this exact bake, if a previous session
 * paid for one that never landed. */
function heldTicket(projectId: string, clipId: string, fp: string): HostedBakeTicket | undefined {
  return readTickets().find(
    (t) => t.projectId === projectId && t.clipId === clipId && t.fp === fp
  )?.gen;
}

/** Bakes that failed, per quality, so a doc sweep leaves the error standing
 * until the clip changes or the user retries. */
const failed = new Map<string, { fp: string; quality: MatteQuality }>();

const clipOf = (clipId: string): VideoClip | undefined =>
  useEditor.getState().clips.find((c) => c.id === clipId);

/** The fingerprint an AI-mode clip's matte must carry, or null when the clip
 * owes no matte at all. */
function owedFingerprint(clip: VideoClip | undefined): string | null {
  const r = clip?.removal;
  if (!clip || !r || r.off) return null;
  // Every bake waits for its explicit start — the panel's Apply or the chat
  // tool sets `requested` — and a custom bake also needs something to
  // follow: painted seeds or a described subject.
  if (!r.requested) return null;
  if (
    r.mode === "custom" &&
    !r.seeds?.prompts.length &&
    !r.seeds?.paint?.length &&
    !r.subject?.trim()
  )
    return null;
  return removalFingerprint(clip.assetId, r);
}

/** Whether the stored matte's baked range still spans the clip's trims —
 * a matte wider than the clip plays is fine; one the trim reached past
 * wants a re-bake. Stills always cover. */
function matteCovers(matte: NonNullable<ClipRemoval["matte"]>, clip: VideoClip): boolean {
  const s = useEditor.getState();
  const matteAsset = s.assets.find((a) => a.id === matte.assetId);
  const source = s.assets.find((a) => a.id === clip.assetId);
  if (!matteAsset) return false;
  if (source?.type === "image") return true;
  const dur = matteAsset.duration ?? 0;
  return clip.in >= matte.in - 0.05 && clip.out <= matte.in + dur + 0.2;
}

/** A matte some other clip already carries for this exact selection, whose
 * baked range spans this clip's trims. hq wins when both tiers exist. */
function twinMatte(
  clipId: string,
  fp: string,
  clip: VideoClip
): NonNullable<ClipRemoval["matte"]> | null {
  const s = useEditor.getState();
  let found: NonNullable<ClipRemoval["matte"]> | null = null;
  for (const c of s.clips) {
    if (c.id === clipId) continue;
    const m = c.removal?.matte;
    if (!m || m.fingerprint !== fp || !s.assets.some((a) => a.id === m.assetId)) continue;
    if (!matteCovers(m, clip)) continue;
    if (m.quality === "hq") return m;
    found ??= m;
  }
  return found;
}

export function cancelMatteBake(clipId: string): void {
  running.get(clipId)?.ctl.abort();
  running.delete(clipId);
  failed.delete(clipId);
  // The ticket stays: the paid track keeps running upstream, and an undo
  // that brings the same selection back resumes it free. The sweep retires
  // tickets that can never land.
  setJob(clipId, null);
}

/** Clear a failed bake and run the ladder again — the panel's Retry, and the
 * upgrade affordance after a credit top-up. */
export function retryMatteBake(clipId: string): void {
  failed.delete(clipId);
  setJob(clipId, null);
  ensureMatteBake(clipId, { whileBrushing: true });
}

/** The brush panel's Apply: start the tracked bake for what's painted so
 * far, with the session still open for touch-ups. */
export function confirmMatteBake(clipId: string): void {
  ensureMatteBake(clipId, { whileBrushing: true });
}

/**
 * Make sure the clip's AI matte exists and matches its current trims and
 * seeds; start (or restart) whatever rung of the ladder is owed. Safe to
 * call on every panel render.
 */
export function ensureMatteBake(clipId: string, opts: { whileBrushing?: boolean } = {}): void {
  if (!matteBakesAvailable) return;
  const clip = clipOf(clipId);
  const fp = owedFingerprint(clip);
  if (!clip || !fp) {
    cancelMatteBake(clipId);
    return;
  }
  // An open brush session re-fingerprints on every stroke; the bake (and the
  // hosted tier's bill) waits until it closes or the panel's Apply confirms.
  if (!opts.whileBrushing && useBrushUi.getState().clipId === clipId) return;
  const r = clip.removal!;
  // Settled: the stored matte matches the clip and its asset is still around
  // (an undo can revive a matte pointer whose asset was collected).
  const matte = r.matte;
  const stored = matte?.fingerprint === fp && matteCovers(matte, clip) ? matte : null;
  // A split or a paste leaves two clips owing the same selection. A twin
  // matte another clip already carries is adopted whole — same asset, one
  // bake, one bill — as long as its baked range spans this clip's trims. A
  // stored local matte adopts a twin only for the hq upgrade it still owes.
  const twin = twinMatte(clipId, fp, clip);
  const adopt = !stored ? twin : stored.quality === "local" && twin?.quality === "hq" ? twin : null;
  if (adopt) {
    useEditor.getState().updateClipTransient(clipId, { removal: { ...r, matte: adopt } });
    ensureMatteBake(clipId, opts);
    return;
  }
  // What the ladder owes next. Custom tracks an arbitrary object, so only the
  // hosted tracker can bake it; auto gets the free local matte immediately,
  // and the hosted pass upgrades it once `refine` asks — the paid rung runs
  // on that explicit click alone.
  const want: MatteQuality | null =
    r.mode === "custom"
      ? stored
        ? null
        : "hq"
      : stored
        ? stored.quality === "local" && r.refine
          ? "hq"
          : null
        : "local";
  if (!want) {
    cancelMatteBake(clipId);
    return;
  }
  const stuck = failed.get(clipId);
  if (stuck && stuck.fp === fp && stuck.quality === want) return;
  const inFlight = running.get(clipId);
  if (inFlight && inFlight.fp === fp && inFlight.quality === want) return;
  // Another clip is already baking this exact selection — one submit, one
  // bill. When it lands, the sweep runs this clip's ensure again and the
  // twin adoption above picks the result up (or bakes for real when the
  // twin's range turns out not to cover this clip's trims).
  for (const [otherId, run] of running) {
    if (otherId !== clipId && run.fp === fp && (run.quality === want || run.quality === "hq"))
      return;
  }
  inFlight?.ctl.abort();

  const ctl = new AbortController();
  running.set(clipId, { fp, quality: want, ctl });
  failed.delete(clipId);
  setJob(clipId, { quality: want, status: "running", progress: 0, startedAt: Date.now() });
  void runBake(clipId, fp, want, ctl).catch((e: unknown) => {
    if (running.get(clipId)?.ctl !== ctl) return;
    running.delete(clipId);
    if (e instanceof MatteBakeCancelled) {
      setJob(clipId, null);
      return;
    }
    // The ticket stands through failure: the run already forgot any part
    // whose track settled dead, so Retry resumes the paid parts and re-buys
    // only what died.
    failed.set(clipId, { fp, quality: want });
    setJob(clipId, {
      quality: want,
      status: "error",
      progress: 0,
      error: e instanceof Error ? e.message : "The matte could not be baked.",
    });
  });
}

// Bakes run one at a time: each opens its own video decoders on top of the
// preview's, and the browser's decoder pool is finite — two clips refining at
// once is how a healthy mask dies with a decoder error.
let bakeTurn: Promise<void> = Promise.resolve();

async function runBake(
  clipId: string,
  fp: string,
  quality: MatteQuality,
  ctl: AbortController
): Promise<void> {
  const prev = bakeTurn;
  let release!: () => void;
  bakeTurn = new Promise((r) => (release = r));
  try {
    await prev;
    await runBakeNow(clipId, fp, quality, ctl);
  } finally {
    release();
  }
}

async function runBakeNow(
  clipId: string,
  fp: string,
  quality: MatteQuality,
  ctl: AbortController
): Promise<void> {
  if (ctl.signal.aborted) throw new MatteBakeCancelled();
  const state = useEditor.getState();
  const clip = clipOf(clipId);
  const asset = clip && state.assets.find((a) => a.id === clip.assetId);
  if (!clip || !asset || !state.projectId) throw new MatteBakeCancelled();

  let shown = 0;
  const startedAt = Date.now();
  const onProgress = (f: number) => {
    if (f - shown < 0.03 && f < 1) return;
    shown = f;
    if (running.get(clipId)?.ctl !== ctl) return;
    const elapsed = (Date.now() - startedAt) / 1000;
    const secondsLeft =
      f >= 0.05 && elapsed >= 3
        ? Math.max(0, Math.round((elapsed * (1 - f)) / f))
        : undefined;
    setJob(clipId, {
      quality,
      status: "running",
      progress: f,
      secondsLeft,
      etaAt: secondsLeft !== undefined ? Date.now() : undefined,
      startedAt,
    });
  };
  const projectId = state.projectId;
  const baked =
    quality === "hq"
      ? await hostedBakeMatte(asset, clip, {
          signal: ctl.signal,
          onProgress,
          resume: heldTicket(projectId, clipId, fp),
          onSubmitted: (gen) => saveTicket({ projectId, clipId, fp, gen }),
        })
      : await localBakeMatte(asset, clip, { signal: ctl.signal, onProgress });
  if (ctl.signal.aborted) throw new MatteBakeCancelled();

  const file = new File([baked.blob], `matte-${quality}-${fp}.mp4`, { type: "video/mp4" });
  const matteAsset = await importFileToProject(state.projectId, file);
  if (!matteAsset) throw new Error("The matte could not be saved into the project.");
  matteAsset.name = `${asset.name} matte`;
  matteAsset.origin = "matte";

  // The doc may have moved while the bake ran — land only onto the removal
  // the matte was baked for.
  const editor = useEditor.getState();
  const latest = clipOf(clipId);
  const owed = owedFingerprint(latest);
  editor.addAsset(matteAsset);
  dropTicket(clipId);
  if (ctl.signal.aborted || !latest || owed !== fp) {
    editor.removeAsset(matteAsset.id);
    running.delete(clipId);
    setJob(clipId, null);
    // Trims or seeds changed under the bake: the clip still owes a matte.
    if (owed) ensureMatteBake(clipId);
    return;
  }

  const removal: ClipRemoval = {
    ...latest.removal!,
    matte: { assetId: matteAsset.id, fingerprint: fp, quality, in: baked.in },
  };
  editor.updateClipTransient(clipId, { removal });
  // The matte this replaced may still be another clip's (a split, a paste);
  // the sweep collects it once nothing points at it.
  running.delete(clipId);
  setJob(clipId, null);
  // Re-settle: an auto matte that landed with `refine` set owes the quality
  // pass next; anything else just clears its job.
  ensureMatteBake(clipId);
}

/** Drop a cleared removal's matte asset (and its file) from the project. */
export function dropMatteAsset(assetId: string | undefined): void {
  if (!assetId) return;
  const editor = useEditor.getState();
  if (editor.assets.some((a) => a.id === assetId && a.origin === "matte"))
    editor.removeAsset(assetId);
}

/** Settle every clip's matte against the doc: start owed bakes, stop bakes
 * whose clip is gone or left AI mode, collect matte assets nothing points at.
 * Undo, redo, trims and clip deletion all land here. */
function sweepMattes(): void {
  const s = useEditor.getState();
  if (!s.loaded || s.readOnly || !s.projectId) return;
  for (const id of [...running.keys()]) if (!owedFingerprint(clipOf(id))) cancelMatteBake(id);
  for (const c of s.clips) if (owedFingerprint(c)) ensureMatteBake(c.id);
  // Tickets retire by age alone. A cutout that is cleared, a clip that is
  // deleted, a selection that moved on — each keeps its ticket, because an
  // undo brings the old fingerprint back and resumes the paid track for
  // free; a landing or a dead track already dropped its own record, and age
  // retires whatever never comes back.
  for (const t of readTickets()) {
    if (t.projectId !== s.projectId) continue;
    if (Date.now() - (t.at ?? 0) > TICKET_TTL_MS) dropTicket(t.clipId);
  }
  const pointed = new Set<string>();
  for (const c of s.clips) if (c.removal?.matte) pointed.add(c.removal.matte.assetId);
  for (const a of s.assets) if (a.origin === "matte" && !pointed.has(a.id)) s.removeAsset(a.id);
}

// Debounced: a trim drag patches the doc per pointer move, and a landing bake
// registers its asset one set() before the clip points at it — the pause lets
// each settle before the sweep reads it.
let sweepTimer: ReturnType<typeof setTimeout> | null = null;
useEditor.subscribe((s, prev) => {
  if (s.clips === prev.clips && s.assets === prev.assets) return;
  if (sweepTimer) clearTimeout(sweepTimer);
  sweepTimer = setTimeout(sweepMattes, 600);
});

// A closed brush session releases the held bake for its clip.
useBrushUi.subscribe((s, prev) => {
  if (prev.clipId && prev.clipId !== s.clipId) ensureMatteBake(prev.clipId);
});
