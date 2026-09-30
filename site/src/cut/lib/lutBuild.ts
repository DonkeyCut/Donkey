/**
 * Where a clip's color LUT comes from.
 *
 * A clip's color is one recipe — its source profile, its grade, the project's
 * output space and a lattice size — and the kit bakes that recipe into a 3D
 * LUT (effects-kit colorPipeline.ts). Baking is the one expensive step, and
 * it must never hold the frame loop: in the tab a module Worker builds the
 * lattice and transfers it back, and the compositor keeps drawing the last
 * LUT it had for the clip until the new one lands. A process with no Worker
 * (the headless runner, tests) builds inline, and a caller that needs the
 * exact picture now (an export) asks for it inline in the tab too.
 *
 * Sizes come from the color setting: the standard cube for Rec.709 and sRGB
 * sources, the wide cube for log and HDR, and a draft cube while a slider is
 * moving — the full cube follows when the drag settles. The built LUTs are a
 * cache bounded in bytes through the memory budget.
 */

import {
  buildClipLut,
  recipeKey,
  type ClipColorRecipe,
  type ColorGrade,
  type GradeLut,
  type OutputSpace,
  type ParsedLut,
  type SourceProfile,
} from "@donkeycut/effects-kit";
import { cutColor } from "./colorSettings";
import { cachedLut, loadLibraryLut, lutIdOf } from "./linkedLibrary/luts";
import { allowance, holdMemory } from "./memoryBudget";
import { colorRead, type ReadFile } from "./sourceColor";
import type { MediaAsset } from "./types";

/** The source half of a recipe: the profile, the file's matrix and range,
 * and the ones this process drew the picture with (sourceColor.ts). */
export type RecipeSource = Omit<ClipColorRecipe, "grade" | "output" | "size">;

type LookupAsset = { id: string } & Pick<MediaAsset, "color" | "proxyUrl">;

const lookups = new WeakMap<object, Map<unknown, (clip: { assetId: string }) => RecipeSource>>();

/** A clip → source lookup over a document's assets, for frames read from
 * `fileOf(asset)`: the reader that draws the clip names the same file, so
 * the recipe describes the frames it hands over. Kept per assets array and
 * file choice, so a frame loop pays one map build per document change. The
 * source itself is read per call: the decode route's measurement can settle
 * after the map was built, and the recipe key follows it. */
export function sourceLookup(
  assets: readonly LookupAsset[],
  fileOf: (asset: LookupAsset) => ReadFile
): (clip: { assetId: string }) => RecipeSource {
  let byFile = lookups.get(assets);
  if (!byFile) lookups.set(assets, (byFile = new Map()));
  let fn = byFile.get(fileOf);
  if (!fn) {
    const byId = new Map(assets.map((a) => [a.id, a] as const));
    fn = (clip) => {
      const asset = byId.get(clip.assetId);
      return asset ? colorRead(asset, fileOf(asset)).recipe() : REC709;
    };
    byFile.set(fileOf, fn);
  }
  return fn;
}

const REC709: RecipeSource = { profile: "rec709" };

const isSdrSource = (profile: SourceProfile) => profile === "rec709" || profile === "srgb";

/** Lattice nodes per axis for a source, at draft or full quality. */
export function lutSizeFor(profile: SourceProfile, draft = false): number {
  const c = cutColor();
  return draft ? c.draftLutSize : isSdrSource(profile) ? c.lutSize : c.lutSizeWide;
}

/* ------------------------------------------------------------------ */
/* Draft mode                                                          */
/* ------------------------------------------------------------------ */

let drafting = 0;

/** A slider drag has begun: LUTs build at the draft size until it ends. */
export function beginLutDraft(): void {
  drafting++;
}

export function endLutDraft(): void {
  drafting = Math.max(0, drafting - 1);
}

export const lutDraftActive = (): boolean => drafting > 0;

/** Recipes already made, by grade object, then source object, then output
 * and size. The compositor asks for every graded clip's recipe every frame,
 * and grades, sources and recipes are all replaced whole when they change,
 * so a frame that changes nothing hands back the recipe it had — and the key
 * cached on it — without building either again. */
const NO_GRADE = {};
const recipes = new WeakMap<object, WeakMap<RecipeSource, ClipColorRecipe[]>>();
/** Output and size pairs one grade and source keep: the live cube, the draft
 * one, and an export's alongside. */
const RECIPE_VARIANTS = 4;

/** The recipe a clip renders through: its source, its grade, the output
 * space, sized by the source. `draft` takes the drag's cube while one is
 * live; only the live preview asks for it, and every render that writes a
 * picture (an export, a baked layer) builds the full cube. The same inputs
 * answer the same recipe object. */
export function clipRecipe(
  source: RecipeSource,
  grade: ColorGrade | undefined | null,
  output: OutputSpace = "sdr",
  draft = false
): ClipColorRecipe {
  const size = lutSizeFor(source.profile, draft && lutDraftActive());
  let bySource = recipes.get(grade ?? NO_GRADE);
  if (!bySource) recipes.set(grade ?? NO_GRADE, (bySource = new WeakMap()));
  let made = bySource.get(source);
  if (!made) bySource.set(source, (made = []));
  for (let i = 0; i < made.length; i++) {
    const r = made[i];
    if (r.output === output && r.size === size) return r;
  }
  const recipe: ClipColorRecipe = { ...source, grade: grade ?? undefined, output, size };
  made.unshift(recipe);
  if (made.length > RECIPE_VARIANTS) made.pop();
  return recipe;
}

/* ------------------------------------------------------------------ */
/* The cache                                                           */
/* ------------------------------------------------------------------ */

export interface ClipLut {
  lut: GradeLut;
  key: string;
}

/** Bytes of built lattices kept before the budget has its say. */
const TUNED_BYTES = 24 * 2 ** 20;

const built = new Map<string, { clip: ClipLut; bytes: number }>();
let held = 0;
holdMemory("gradeLuts", () => held);

function remember(key: string, lut: GradeLut): ClipLut {
  const bytes = lut.data.byteLength;
  forget(key);
  const cap = allowance("gradeLuts", TUNED_BYTES);
  for (const [oldest, entry] of built) {
    if (held + bytes <= cap) break;
    built.delete(oldest);
    held -= entry.bytes;
  }
  const clip = { lut, key };
  built.set(key, { clip, bytes });
  held += bytes;
  return clip;
}

function forget(key: string): void {
  const hit = built.get(key);
  if (!hit) return;
  built.delete(key);
  held -= hit.bytes;
}

/** A built LUT already in hand, bumped to most recently used. */
export function peekClipLut(key: string): ClipLut | undefined {
  const hit = built.get(key);
  if (!hit) return undefined;
  built.delete(key);
  built.set(key, hit);
  return hit.clip;
}

/** Keys already worked out, by recipe object: the recipe's own, and the last
 * library-LUT state it was keyed with. */
const keys = new WeakMap<ClipColorRecipe, { base: string; lutId: string | null; lutLoaded: boolean; key: string }>();

/** The identity of a recipe's baked result, the library LUT included: the
 * table the recipe was baked with, or the fact that it was baked without it
 * while the file was still loading. "" for the identity mapping. Kept per
 * recipe object, so a recipe asked for again is keyed without any JSON. */
export function clipLutKey(recipe: ClipColorRecipe, lutId: string | null, lutLoaded: boolean): string {
  let held = keys.get(recipe);
  if (held && held.lutId === lutId && held.lutLoaded === lutLoaded) return held.key;
  const base = held ? held.base : recipeKey(recipe);
  const key = base && lutId ? `${base}|${lutId}:${lutLoaded ? "on" : "off"}` : base;
  if (held) {
    held.lutId = lutId;
    held.lutLoaded = lutLoaded;
    held.key = key;
  } else keys.set(recipe, (held = { base, lutId, lutLoaded, key }));
  return key;
}

/** Bake the recipe now, on this thread. */
function buildNow(recipe: ClipColorRecipe, userLut: ParsedLut | undefined, key: string): ClipLut | null {
  const lut = buildClipLut(recipe, userLut);
  if (!lut) return null;
  return remember(key, lut);
}

/* ------------------------------------------------------------------ */
/* The worker                                                          */
/* ------------------------------------------------------------------ */

export interface LutWorkerBuild {
  kind: "build";
  key: string;
  recipe: ClipColorRecipe;
  lutId: string | null;
}

export interface LutWorkerTable {
  kind: "lut";
  id: string;
  lut: ParsedLut;
  /** Bytes of tables the worker may hold: this cache's allowance. */
  cap: number;
}

export type LutWorkerRequest = LutWorkerBuild | LutWorkerTable;

export type LutWorkerReply =
  | {
      kind: "built";
      key: string;
      size: number;
      /** Null for an identity recipe. */
      data: Float32Array | null;
    }
  /** The worker no longer holds the library LUT the build named. */
  | { kind: "missing"; key: string; id: string }
  /** What the worker holds after taking a table, and what it let go. */
  | { kind: "tables"; bytes: number; evicted: string[] };

type Waiter = {
  resolve: (lut: ClipLut | null) => void;
  wake: (() => void)[];
  /** What the build was asked with, to ask again with the table. */
  build: LutWorkerBuild;
  userLut: ParsedLut | undefined;
};

let worker: Worker | null | false = null;
const sentTables = new Set<string>();
const inFlight = new Map<string, Waiter>();

/** Bytes of library tables the worker may hold before the budget has its
 * say. A 65-point cube is 3.3 MB. */
const WORKER_TABLE_BYTES = 48 * 2 ** 20;

/** Bytes of library tables the worker holds, as it last reported them. */
let workerTables = 0;
holdMemory("lutWorkerTables", () => workerTables);

/** Take the worker's report of the tables it holds: the bytes count in the
 * budget, and a table it let go is sent again with its next build. */
export function noteWorkerTables(reply: { bytes: number; evicted: string[] }): void {
  workerTables = reply.bytes;
  for (const id of reply.evicted) sentTables.delete(id);
}

/** Bytes of library tables the worker holds, as last reported. */
export const workerTableBytes = (): number => workerTables;

/** A library table on its way to the worker, and the buffers it moves. The
 * page keeps its own table for inline builds, so the worker gets a copy made
 * once here and transferred, never cloned again on the way over. */
export function tableMessage(id: string, lut: ParsedLut): { msg: LutWorkerTable; transfer: ArrayBuffer[] } {
  const transfer: ArrayBuffer[] = [];
  const copy = <T extends { data: Float32Array }>(t: T | undefined): T | undefined => {
    if (!t) return undefined;
    const data = t.data.slice();
    transfer.push(data.buffer);
    return { ...t, data };
  };
  const moved: ParsedLut = { ...lut, shaper: copy(lut.shaper), cube: copy(lut.cube) };
  if (!moved.shaper) delete moved.shaper;
  if (!moved.cube) delete moved.cube;
  return {
    msg: { kind: "lut", id, lut: moved, cap: allowance("lutWorkerTables", WORKER_TABLE_BYTES) },
    transfer,
  };
}

function sendTable(w: Worker, id: string, lut: ParsedLut): void {
  const { msg, transfer } = tableMessage(id, lut);
  sentTables.add(id);
  w.postMessage(msg, transfer);
}

/** The build worker, made on first use; false once it is known not to
 * exist here (no Worker, or one that would not start). */
function lutWorker(): Worker | null {
  if (worker === false) return null;
  if (worker) return worker;
  if (typeof window === "undefined" || typeof Worker !== "function") {
    worker = false;
    return null;
  }
  try {
    const w = new Worker(new URL("./lutBuild.worker.ts", import.meta.url), { type: "module" });
    w.onmessage = (e: MessageEvent<LutWorkerReply>) => {
      const reply = e.data;
      if (reply.kind === "tables") {
        noteWorkerTables(reply);
        return;
      }
      if (reply.kind === "missing") {
        // The worker let the table go: send it again, then the same build.
        const waiter = inFlight.get(reply.key);
        if (!waiter?.userLut) return;
        sendTable(w, reply.id, waiter.userLut);
        w.postMessage(waiter.build);
        return;
      }
      const { key, size, data } = reply;
      const waiter = inFlight.get(key);
      inFlight.delete(key);
      let result: ClipLut | null = null;
      if (data) result = remember(key, { size, data });
      waiter?.resolve(result);
      for (const wake of waiter?.wake ?? []) wake();
    };
    w.onerror = () => {
      // A worker that dies takes its queue and its tables with it: settle the
      // waiters by building here, and build inline from now on.
      worker = false;
      w.terminate();
      workerTables = 0;
      sentTables.clear();
      const pending = [...inFlight.values()];
      inFlight.clear();
      for (const waiter of pending) {
        waiter.resolve(null);
        for (const wake of waiter.wake) wake();
      }
    };
    worker = w;
    return w;
  } catch {
    worker = false;
    return null;
  }
}

/** Hand the worker a build, giving it the library LUT first the one time. */
function buildInWorker(
  w: Worker,
  recipe: ClipColorRecipe,
  lutId: string | null,
  userLut: ParsedLut | undefined,
  key: string,
  wake: (() => void) | undefined
): Promise<ClipLut | null> {
  const held = inFlight.get(key);
  if (held) {
    if (wake) held.wake.push(wake);
    return new Promise((resolve) => {
      const prev = held.resolve;
      held.resolve = (lut) => {
        prev(lut);
        resolve(lut);
      };
    });
  }
  if (lutId && userLut && !sentTables.has(lutId)) sendTable(w, lutId, userLut);
  const build: LutWorkerBuild = { kind: "build", key, recipe, lutId: userLut ? lutId : null };
  return new Promise((resolve) => {
    inFlight.set(key, { resolve, wake: wake ? [wake] : [], build, userLut });
    w.postMessage(build);
  });
}

/* ------------------------------------------------------------------ */
/* Requests                                                            */
/* ------------------------------------------------------------------ */

const lutLoads = new Map<string, Promise<void>>();

/** Start reading a library LUT the recipe names, waking the caller when it is
 * in hand. A read that fails is dropped, so the clip renders without it. */
function fetchLibraryLut(lutId: string, wake: (() => void) | undefined): Promise<void> {
  let p = lutLoads.get(lutId);
  if (!p) {
    p = loadLibraryLut(lutId)
      .then(() => undefined)
      .catch(() => undefined)
      .finally(() => lutLoads.delete(lutId));
    lutLoads.set(lutId, p);
  }
  if (wake) void p.then(wake);
  return p;
}

/**
 * The LUT for a recipe: `null` when the recipe is the identity (draw the
 * picture as it is), the built LUT when it is in hand, and `undefined` while
 * it is being built off the thread — the caller draws what it drew last and
 * `wake` fires when the LUT lands. `exact` builds on this thread instead, so
 * the answer is never `undefined`.
 */
export function requestClipLut(
  recipe: ClipColorRecipe,
  opts: { exact?: boolean; wake?: () => void } = {}
): ClipLut | null | undefined {
  const lutId = lutIdOf(recipe.grade);
  const userLut = lutId ? cachedLut(lutId) : undefined;
  if (lutId && !userLut) void fetchLibraryLut(lutId, opts.wake);
  const key = clipLutKey(recipe, lutId, !!userLut);
  if (!key) return null;
  const hit = peekClipLut(key);
  if (hit) return hit;
  const w = opts.exact ? null : lutWorker();
  if (!w) return buildNow(recipe, userLut, key);
  void buildInWorker(w, recipe, lutId, userLut, key, opts.wake);
  return undefined;
}

/**
 * Every LUT the recipes need, in hand: library LUTs read, lattices built.
 * What an export calls before its first frame, so no frame is drawn through
 * a LUT that was still loading. A library LUT that cannot be read fails the
 * call, naming it.
 */
export async function ensureClipLuts(recipes: ClipColorRecipe[]): Promise<void> {
  const ids = new Set<string>();
  for (const r of recipes) {
    const id = lutIdOf(r.grade);
    if (id) ids.add(id);
  }
  await Promise.all([...ids].map((id) => loadLibraryLut(id)));
  const w = lutWorker();
  await Promise.all(
    recipes.map((recipe) => {
      const lutId = lutIdOf(recipe.grade);
      const userLut = lutId ? cachedLut(lutId) : undefined;
      const key = clipLutKey(recipe, lutId, !!userLut);
      if (!key || peekClipLut(key)) return Promise.resolve();
      if (!w) {
        buildNow(recipe, userLut, key);
        return Promise.resolve();
      }
      return buildInWorker(w, recipe, lutId, userLut, key, undefined).then((lut) => {
        // A worker that died mid-build answers null for a live recipe.
        if (!lut && !peekClipLut(key) && recipeKey(recipe)) buildNow(recipe, userLut, key);
      });
    })
  );
}

/** Drop every built LUT (tests, and a session that changes its settings). */
export function clearClipLuts(): void {
  built.clear();
  held = 0;
}
