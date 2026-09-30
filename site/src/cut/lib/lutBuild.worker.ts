/**
 * The LUT build worker: bakes clip color recipes off the main thread
 * (lutBuild.ts). Library LUTs arrive once by id and are held here, least
 * recently used first out past the byte cap the page hands over with every
 * table (its memory budget's allowance for this cache); after each table the
 * worker reports what it holds and what it let go, so the page counts these
 * bytes in the budget and sends an evicted table again with its next build. A
 * build that names a table no longer held answers `missing`, and the page
 * sends the table again with the build. The kit's source-lattice cache lives
 * in this thread too, so a grade-only change composes over an
 * already-sampled source conversion.
 */

import { buildClipLut, lutBytes, type ParsedLut } from "@donkeycut/effects-kit";
import type { LutWorkerReply, LutWorkerRequest } from "./lutBuild";

/** Tables always held, whatever the cap: two clips graded with two large
 * LUTs build in turn, and a cache that kept only the newest would drop and
 * re-receive a table on every build. */
const KEEP_NEWEST = 2;

/** Parsed library LUTs by id, least recently used first out past `cap`
 * bytes. The two most recently used tables are always kept. */
export class TableCache {
  private tables = new Map<string, { lut: ParsedLut; bytes: number }>();
  private held = 0;
  constructor(private cap: number) {}

  /** Hold `lut` under `id`, returning the ids let go to make room. */
  keep(id: string, lut: ParsedLut): string[] {
    const old = this.tables.get(id);
    if (old) {
      this.tables.delete(id);
      this.held -= old.bytes;
    }
    const bytes = lutBytes(lut);
    this.tables.set(id, { lut, bytes });
    this.held += bytes;
    return this.shed();
  }

  /** Take a new cap, returning the ids let go to fit under it. */
  setCap(cap: number): string[] {
    this.cap = cap;
    return this.shed();
  }

  take(id: string): ParsedLut | undefined {
    const hit = this.tables.get(id);
    if (!hit) return undefined;
    this.tables.delete(id);
    this.tables.set(id, hit);
    return hit.lut;
  }

  get bytes(): number {
    return this.held;
  }

  private shed(): string[] {
    const evicted: string[] = [];
    for (const [oldest, entry] of this.tables) {
      if (this.held <= this.cap || this.tables.size <= KEEP_NEWEST) break;
      this.tables.delete(oldest);
      this.held -= entry.bytes;
      evicted.push(oldest);
    }
    return evicted;
  }
}

/** Until the page's first table names the cap, nothing is held to cap. */
const tables = new TableCache(0);

const post = (reply: LutWorkerReply, transfer: Transferable[] = []) =>
  (self as unknown as Worker).postMessage(reply, transfer);

self.onmessage = (e: MessageEvent<LutWorkerRequest>) => {
  const msg = e.data;
  if (msg.kind === "lut") {
    const evicted = [...tables.setCap(msg.cap), ...tables.keep(msg.id, msg.lut)];
    post({ kind: "tables", bytes: tables.bytes, evicted });
    return;
  }
  const userLut = msg.lutId ? tables.take(msg.lutId) : undefined;
  if (msg.lutId && !userLut) {
    post({ kind: "missing", key: msg.key, id: msg.lutId });
    return;
  }
  const lut = buildClipLut(msg.recipe, userLut);
  post({ kind: "built", key: msg.key, size: lut?.size ?? 0, data: lut?.data ?? null }, lut ? [lut.data.buffer] : []);
};
