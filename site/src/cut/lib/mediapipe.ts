"use client";

/**
 * The MediaPipe vision runtime every on-device model shares: the self-hosted
 * wasm (staged into public/ on install) and the quiet log channel its tasks
 * start under. The person segmenter (cutout.ts) and the landmark trackers
 * (tracking.ts) both create their tasks through here.
 */

const WASM_BASE = "/mediapipe/wasm";

type Fileset = Awaited<ReturnType<typeof import("@mediapipe/tasks-vision").FilesetResolver.forVisionTasks>>;

let filesetOnce: Promise<Fileset> | null = null;

/** The wasm fileset, resolved once per page. */
export function visionFileset(): Promise<Fileset> {
  filesetOnce ??= import("@mediapipe/tasks-vision")
    .then(({ FilesetResolver }) => FilesetResolver.forVisionTasks(WASM_BASE))
    .catch((e: unknown) => {
      filesetOnce = null;
      throw e;
    });
  return filesetOnce;
}

/**
 * Give the wasm module somewhere quiet to log.
 *
 * TFLite writes its start-up notes ("INFO: Created TensorFlow Lite XNNPACK
 * delegate for CPU.", the GL and feedback-manager warnings) to the module's
 * stderr, and Emscripten binds stderr to `console.error` as the glue script
 * evaluates. Next's dev overlay classifies by channel rather than severity, so
 * an INFO line arrives on screen as a page error, pinned to whichever frame
 * happened to be running — in practice the behind-speaker pass, mid-playback.
 *
 * Emscripten reads `print`/`printErr` off the module object, and the task
 * runner passes a pre-set `self.Module` through to the factory (copying its own
 * `locateFile` onto it and clearing the global afterwards). Pointing those at
 * `console.debug` keeps the notes readable under verbose logging and off the
 * error channel. Patching `console.error` around the call cannot work: the glue
 * captured the original binding before we could reach it.
 */
type EmscriptenScope = typeof globalThis & { Module?: Record<string, unknown> };

export async function withQuietWasmLogs<T>(create: () => Promise<T>): Promise<T> {
  const scope = globalThis as EmscriptenScope;
  const prior = scope.Module;
  const note = (...args: unknown[]) => console.debug("[mediapipe]", ...args);
  scope.Module = { print: note, printErr: note };
  try {
    return await create();
  } finally {
    if (prior === undefined) delete scope.Module;
    else scope.Module = prior;
  }
}
