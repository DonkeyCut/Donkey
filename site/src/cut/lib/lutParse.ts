"use client";

/**
 * Parsing a LUT file off the main thread. A 33-point cube is 36k lines of
 * text and a 65-point one 275k, so in the tab a module Worker reads them and
 * the page never stalls on a LUT tile or a clip's first grade. A process with
 * no Worker parses inline.
 */

import { parseLutFile, type ParsedLut } from "@donkeycut/effects-kit";

export interface LutParseRequest {
  id: number;
  fileName: string;
  bytes: ArrayBuffer;
}

export type LutParseReply = { id: number; lut: ParsedLut } | { id: number; error: string };

let worker: Worker | null | false = null;
let seq = 0;
const waiting = new Map<number, { resolve: (lut: ParsedLut) => void; reject: (e: Error) => void }>();

/** The parse worker, made on first use; false once it is known not to exist
 * here (no Worker, or one that would not start). */
function parseWorker(): Worker | null {
  if (worker === false) return null;
  if (worker) return worker;
  if (typeof window === "undefined" || typeof Worker !== "function") {
    worker = false;
    return null;
  }
  try {
    const w = new Worker(new URL("./lutParse.worker.ts", import.meta.url), { type: "module" });
    w.onmessage = (e: MessageEvent<LutParseReply>) => {
      const reply = e.data;
      const waiter = waiting.get(reply.id);
      waiting.delete(reply.id);
      if ("error" in reply) waiter?.reject(new Error(reply.error));
      else waiter?.resolve(reply.lut);
    };
    w.onerror = () => {
      // A worker that dies takes its queue with it: fail what it held, and
      // parse inline from now on.
      worker = false;
      w.terminate();
      const pending = [...waiting.values()];
      waiting.clear();
      for (const waiter of pending) waiter.reject(new Error("The LUT could not be read."));
    };
    worker = w;
    return w;
  } catch {
    worker = false;
    return null;
  }
}

/** Parse a LUT file's bytes by its extension. The caller's bytes are left as
 * they were: the worker gets a copy. */
export function parseLutBytes(fileName: string, bytes: Uint8Array): Promise<ParsedLut> {
  const w = parseWorker();
  if (!w) return Promise.resolve().then(() => parseLutFile(fileName, new TextDecoder().decode(bytes)));
  const id = ++seq;
  const copy = bytes.slice().buffer;
  return new Promise((resolve, reject) => {
    waiting.set(id, { resolve, reject });
    w.postMessage({ id, fileName, bytes: copy } satisfies LutParseRequest, [copy]);
  });
}
