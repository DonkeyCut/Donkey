"use client";

/**
 * Library items a document points at instead of copying.
 *
 * Most of what comes off the Library is copied when it is used: a clip's bytes
 * become the project's own, and the shelf and the project go their separate
 * ways. Some kinds are pointed at instead — a font is named by every title set
 * in it, and the file stays on the shelf where every project can reach it.
 * Those links are what this module keeps honest, for fonts today and for
 * whatever is linked rather than copied next.
 *
 * Three rules hold for every linked kind:
 *
 * - **Identity is the bytes.** A linked item is keyed by a hash of its content,
 *   not by the shelf row holding it, so the same file on two shelves is one
 *   item and one id. That is what lets a project change residency without a
 *   word of it being rewritten.
 * - **New ones land where everything can read them.** The cloud shelf, when
 *   there is room and the item is small enough that where it sits is not a real
 *   choice — a render job reads no other shelf.
 * - **They travel with the project.** A project moving to the cloud takes the
 *   linked items it depends on with it.
 */

import { readSnapshot, writeSnapshot } from "../cache";
import { contentKey } from "../contentKey";
import {
  fetchLibrary,
  moveLibraryItem,
  uploadToLibrary,
  type LibraryAsset,
} from "../library";
import { activeResidency, backendFor, type Residency } from "../residency";
import type { ProjectDoc } from "../types";

/** One shelf row carrying a linked item's bytes. */
export interface LinkedCopy {
  assetId: string;
  residency: Residency;
  fileName: string;
  name: string;
}

/** A linked item as its menu knows it: one thing, however many shelves hold it. */
export interface LinkedItem {
  /** Content key — see the module note. */
  key: string;
  prefix: string;
  label: string;
  copies: LinkedCopy[];
}

/**
 * A kind of library item documents link to. Registered once at module load by
 * the feature that owns it.
 */
export interface LinkedKind {
  /** Id prefix a document writes, e.g. "font" for `font:<key>`. */
  prefix: string;
  /** The library asset type carrying it. */
  type: LibraryAsset["type"];
  /** A kind keyed off its shelf row: the page that shelved the file wrote its
   * content key onto the row (`LibraryAsset.contentKey`), so a sync lists it
   * without reading a byte. Its bytes are read when something uses it. A row
   * without a key is left out of the listing. */
  lazy?: true;
  /** The ids of this kind a document is set in, so a project move can carry
   * them. */
  extract: (doc: ProjectDoc) => string[];
  /** Put one item's bytes to use in this process — installing a font face,
   * say. Throwing leaves the item out of the listing. */
  use?: (key: string, label: string, bytes: ArrayBuffer) => Promise<void>;
  /** Keys that have left the shelf, so the feature can drop them. */
  drop?: (keys: string[]) => void;
  /** Carry a renamed item's new name to the feature already using it. */
  relabel?: (key: string, label: string) => void;
  /** Folder a new one is filed into when the shelf has one by that name. */
  homeFolder?: string;
  /** Whether a dropped OS file is one of these. */
  matches: (file: File) => boolean;
  /** What a file picker offers for this kind, archives included. */
  accept?: string;
  /** Files inside an archive of this kind, or `null` when the file is not one.
   * A font arrives as a zip from every foundry that publishes one, and a
   * template or a sticker pack will arrive the same way. */
  unpack?: (file: File) => Promise<File[] | null>;
}

const kinds = new Map<string, LinkedKind>();

export function registerLinkedKind(kind: LinkedKind): void {
  kinds.set(kind.prefix, kind);
}

export const linkId = (prefix: string, key: string) => `${prefix}:${key}`;

/** Whether the Library lends this kind of item rather than copying it — what
 * tells an upload to reach for a shelf every surface can read, and a delete to
 * take it out of the menus that offer it. */
export const isLinkedType = (type: LibraryAsset["type"]): boolean =>
  [...kinds.values()].some((k) => k.type === type);

/** Whether a dropped OS file is a linked kind. */
export const isLinkedFile = (file: File): boolean =>
  [...kinds.values()].some((k) => k.matches(file));

/** What every linked kind takes, for a file input's `accept` — or one kind's,
 * for a picker that offers only that. */
export const linkedAccept = (prefix?: string): string =>
  [...kinds.values()]
    .filter((k) => !prefix || k.prefix === prefix)
    .flatMap((k) => (k.accept ? [k.accept] : []))
    .join(",");

/** The library asset type a dropped OS file would shelve as, when a linked
 * kind claims it. */
export const linkedTypeOfFile = (file: File): LibraryAsset["type"] | null =>
  [...kinds.values()].find((k) => k.matches(file))?.type ?? null;

/**
 * A dropped batch with its archives opened.
 *
 * What a user has in hand is what the download gave them, and for a font that
 * is a zip. Opening it here means every intake point — the Library page, the
 * editor's panel, the font menu — takes the file as it arrived. A file no kind
 * claims passes through untouched.
 */
export async function expandLinkedFiles(files: File[]): Promise<File[]> {
  const out: File[] = [];
  for (const file of files) {
    let opened: File[] | null = null;
    for (const kind of kinds.values()) {
      opened = (await kind.unpack?.(file).catch(() => null)) ?? null;
      if (opened) break;
    }
    out.push(...(opened ?? [file]));
  }
  return out;
}

/** Items small enough that which shelf holds them is not a real choice. Past
 * this, a new item stays on the shelf the user is working from, because moving
 * real weight into someone's cloud quota is their call to make. */
export const LINKED_CARRY_MAX_BYTES = 10 * 1024 ** 2;

let items: LinkedItem[] = [];
const byAsset = new Map<string, LinkedItem>();
/** Keys already in use in this process, per kind. */
const used = new Map<string, Promise<void>>();
/** The name each item in use was last put to use under. */
const labels = new Map<string, string>();
const listeners = new Set<() => void>();

/** One array per kind, held until the listing changes: a subscriber reads this
 * on every render and a fresh array each time would never settle. */
const perKind = new Map<string, LinkedItem[]>();

export const listLinked = (prefix: string): LinkedItem[] => {
  const held = perKind.get(prefix);
  if (held) return held;
  const made = items.filter((i) => i.prefix === prefix);
  perKind.set(prefix, made);
  return made;
};

/** The link id a Library card should render itself as. */
export const linkIdForAsset = (assetId: string): string | null => {
  const hit = byAsset.get(assetId);
  return hit ? linkId(hit.prefix, hit.key) : null;
};

export function onLinkedChanged(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

function publish(next: LinkedItem[]): void {
  items = next;
  perKind.clear();
  byAsset.clear();
  for (const i of next) for (const c of i.copies) byAsset.set(c.assetId, i);
  for (const cb of listeners) cb();
}

export { contentKey };

const bytesKey = (assetId: string) => `linked/${assetId}`;

/** The bytes for one shelf item: off the shelf when it answers, else the copy
 * kept from the last time it did. Something that has been used once keeps
 * working when the shelf holding it is out of reach.
 *
 * Read through the shelf's own backend rather than its URL: a render job
 * carries its auth in headers the page gets from a cookie, and the browser
 * shelf answers in the page rather than over the network. */
export async function linkedBytes(
  a: Pick<LibraryAsset, "id" | "fileName" | "residency">,
): Promise<ArrayBuffer> {
  try {
    const res = await backendFor(a.residency).fetch(
      `/api/cut/library/media/${encodeURIComponent(a.fileName)}`,
    );
    if (!res.ok) throw new Error("linked item fetch failed");
    const bytes = await res.arrayBuffer();
    writeSnapshot(bytesKey(a.id), bytes);
    return bytes;
  } catch (e) {
    const hit = await readSnapshot<ArrayBuffer>(bytesKey(a.id));
    if (hit) return hit.value;
    throw e;
  }
}

function put(
  kind: LinkedKind,
  key: string,
  label: string,
  bytes: ArrayBuffer | null,
): Promise<void> {
  const id = linkId(kind.prefix, key);
  let hit = used.get(id);
  if (labels.get(id) !== label) {
    if (hit) void hit.then(() => kind.relabel?.(key, label));
    labels.set(id, label);
  }
  if (hit) return hit;
  hit = (kind.use && bytes ? kind.use(key, label, bytes) : Promise.resolve()).catch(
    () => {
      // Bytes that will not load: drop the marker so a later pass retries, and
      // let whatever points at them fall back.
      used.delete(id);
    },
  );
  used.set(id, hit);
  return hit;
}

/**
 * Reconcile this process with the account's linked items: put new ones to use,
 * drop deleted ones, and publish the listing their menus draw.
 *
 * The editor calls this on open and after every upload or delete; a headless
 * run awaits it before drawing anything.
 */
export async function syncLinkedLibrary(): Promise<void> {
  if (kinds.size === 0) return;
  const types = new Set([...kinds.values()].map((k) => k.type));
  let shelf: LibraryAsset[];
  try {
    shelf = (await fetchLibrary()).assets.filter((a) => types.has(a.type));
  } catch {
    // No shelf reachable: keep whatever is already in use rather than tearing
    // the user's items out of a menu mid-session.
    return;
  }
  const kindFor = (a: LibraryAsset) =>
    [...kinds.values()].find((k) => k.type === a.type);
  // Read and key every shelf copy at once, then put them to use in a fixed
  // order: two shelves holding one item may have stored it under different
  // names, and a menu should not label it differently from one session to the
  // next. The cloud copy's name wins, since that is the one every surface reads.
  // A lazy kind is keyed off its row and read only when used.
  const read = await Promise.all(
    shelf.map(async (a) => {
      const kind = kindFor(a);
      if (!kind) return null;
      if (kind.lazy) return a.contentKey ? { a, kind, bytes: null, key: a.contentKey } : null;
      try {
        const bytes = await linkedBytes(a);
        return { a, kind, bytes, key: await contentKey(bytes) };
      } catch {
        return null; // That shelf isn't answering; another copy may still serve.
      }
    }),
  );
  const ordered = read
    .filter((r): r is NonNullable<typeof r> => r !== null)
    .sort(
      (x, y) =>
        Number(y.a.residency === "cloud") - Number(x.a.residency === "cloud") ||
        x.a.fileName.localeCompare(y.a.fileName),
    );
  const found = new Map<string, LinkedItem>();
  for (const { a, kind, bytes, key } of ordered) {
    const id = linkId(kind.prefix, key);
    const hit = found.get(id);
    // The first copy in the order names the item; a later one only stands
    // in for its bytes.
    const label = hit?.label ?? a.name;
    await put(kind, key, label, bytes);
    const copy: LinkedCopy = {
      assetId: a.id,
      residency: a.residency,
      fileName: a.fileName,
      name: a.name,
    };
    if (hit) hit.copies.push(copy);
    else
      found.set(id, {
        key,
        prefix: kind.prefix,
        label,
        copies: [copy],
      });
  }
  const stale = [...used.keys()].filter((id) => !found.has(id));
  if (stale.length) {
    for (const id of stale) {
      used.delete(id);
      labels.delete(id);
    }
    for (const kind of kinds.values()) {
      const mine = stale.filter((id) => id.startsWith(`${kind.prefix}:`));
      if (mine.length)
        kind.drop?.(mine.map((id) => id.slice(kind.prefix.length + 1)));
    }
  }
  publish([...found.values()]);
}

/** Drop the shelf copies of the linked assets among `assets` — what a
 * delete of them takes, whether the grid, a folder delete, or the assistant
 * runs it. */
export function forgetLinkedCopies(assets: readonly Pick<LibraryAsset, "id" | "type">[]): void {
  for (const a of assets) if (isLinkedType(a.type)) forgetLinkedCopy(a.id);
}

/** Drop one shelf copy the moment it is deleted, so the shelf and the menus
 * never disagree while the round trip settles. */
export function forgetLinkedCopy(assetId: string): void {
  const item = byAsset.get(assetId);
  if (!item) return;
  const next: LinkedItem[] = [];
  for (const i of items) {
    if (i !== item) {
      next.push(i);
      continue;
    }
    const copies = i.copies.filter((c) => c.assetId !== assetId);
    if (copies.length > 0) next.push({ ...i, copies });
    else {
      const id = linkId(i.prefix, i.key);
      used.delete(id);
      labels.delete(id);
      kinds.get(i.prefix)?.drop?.([i.key]);
    }
  }
  publish(next);
}

/**
 * Which shelf a new item belongs on, when nothing else has decided (something
 * dropped into a folder belongs to that folder's shelf).
 *
 * The cloud, whenever it is small enough and there is room. It is the only
 * shelf every surface can read — a render job reaches nothing else — and below
 * the carry limit where it sits is not a real choice. A large file, a full
 * account, or a cloud that isn't answering lands it on the shelf the user is
 * working from.
 *
 * Room, never tier: a free account has 250MB and a linked item is under one.
 */
export async function shelfForNewItem(bytes: number): Promise<Residency> {
  const here = activeResidency();
  if (here === "cloud") return "cloud";
  if (bytes > LINKED_CARRY_MAX_BYTES) return here;
  try {
    const res = await backendFor("cloud").fetch("/api/cut/usage");
    if (!res.ok) return here;
    const usage = (await res.json()) as {
      bytes: number;
      quotaBytes: number | null;
    };
    if (usage.quotaBytes === null) return "cloud";
    return usage.bytes + bytes <= usage.quotaBytes ? "cloud" : here;
  } catch {
    return here;
  }
}

/** Put a file on the shelf as a linked item of this kind and return its id. */
export async function uploadLinkedItem(
  prefix: string,
  file: File,
): Promise<string> {
  const kind = kinds.get(prefix);
  const residency = await shelfForNewItem(file.size);
  const asset = await uploadToLibrary(file, residency);
  if (kind?.homeFolder) {
    const home = await fetchLibrary()
      .then((d) =>
        d.folders.find(
          (f) => f.residency === residency && f.name === kind.homeFolder,
        ),
      )
      .catch(() => undefined);
    if (home)
      await moveLibraryItem(residency, asset.id, home.id).catch(() => {});
  }
  const key = await contentKey(await file.arrayBuffer());
  await syncLinkedLibrary();
  return linkId(prefix, key);
}

/** Shelve a dropped OS file as whichever linked kind claims it and return its
 * id — what a paste or a drop on the editor does with a font or a LUT. */
export async function uploadLinkedFile(file: File): Promise<string> {
  const kind = [...kinds.values()].find((k) => k.matches(file));
  if (!kind) throw new Error("That file is not something the Library links to.");
  return uploadLinkedItem(kind.prefix, file);
}

/** Every linked id a document is set in, across kinds. */
export function linkedIdsIn(doc: ProjectDoc): string[] {
  const ids = new Set<string>();
  for (const kind of kinds.values())
    for (const id of kind.extract(doc)) ids.add(id);
  return [...ids];
}

/**
 * Make sure the cloud shelf holds these linked items, copying any that live
 * only on a device. What a project needs when it moves to the cloud: a render
 * job reads the cloud shelf alone. The ids don't change — they are the bytes —
 * so the document that referenced them still does.
 */
export async function ensureLinkedOnCloud(
  ids: Iterable<string>,
): Promise<void> {
  const wanted = new Set(ids);
  if (wanted.size === 0) return;
  const missing = items.filter(
    (i) =>
      wanted.has(linkId(i.prefix, i.key)) &&
      !i.copies.some((c) => c.residency === "cloud"),
  );
  if (missing.length === 0) return;
  for (const item of missing) {
    const from = item.copies[0];
    if (!from) continue;
    try {
      const res = await backendFor(from.residency).fetch(
        `/api/cut/library/media/${encodeURIComponent(from.fileName)}`,
      );
      if (!res.ok) continue;
      await uploadToLibrary(
        new File([await res.blob()], from.fileName),
        "cloud",
      );
    } catch {
      // An unreachable shelf or a full account: whatever points at it falls
      // back in a job, and the move itself still goes through.
    }
  }
  await syncLinkedLibrary();
}
