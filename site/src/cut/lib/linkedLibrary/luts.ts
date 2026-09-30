"use client";

/**
 * The account's colour LUTs: `.cube` and `.3dl` files on the Library shelf
 * and the built-in set every account has, named by a clip's grade
 * (`grade.lut.id = "lut:<contentKey>"`) and read the moment a renderer needs
 * the table.
 *
 * A LUT is a linked kind, so identity, placement and travelling with a
 * project live in `registry.ts`. It is also a lazy one: the page that shelved
 * the file parsed it and wrote its content key onto the row, so listing the
 * shelf reads no bytes. The parsed tables are held here under the memory
 * budget and read back on demand.
 */

import { lutBytes, type ColorGrade, type ParsedLut } from "@donkeycut/effects-kit";
import { allowance, holdMemory } from "../memoryBudget";
import { BUILTIN_LUTS, builtinLutByKey, type BuiltinLut } from "../builtinLuts";
import { cloudRequest } from "../backend/cloud";
import { parseLutBytes } from "../lutParse";
import { isLutFile, LUT_ACCEPT } from "../media";
import type { ProjectDoc } from "../types";
import {
  linkedBytes,
  linkId,
  listLinked,
  registerLinkedKind,
  type LinkedItem,
  type LinkedKind,
} from "./registry";

const PREFIX = "lut";

/** The grade id a shelf LUT answers to. */
export const libraryLutId = (key: string) => linkId(PREFIX, key);

/** The file icon with its wordmark: the tile where the file sits at rest. */
export const LUT_FILE_ICON = "/cut/lut-file.svg";
/** The file icon alone: the drag ghost, a clip's LUT badge, the applied chip. */
export const LUT_MARK_ICON = "/cut/lut-file-mark.svg";

/** The LUT a grade names, when it names one off the shelf. */
export function lutIdOf(grade: ColorGrade | undefined | null): string | null {
  const id = (grade as { lut?: { id?: unknown } } | null | undefined)?.lut?.id;
  return typeof id === "string" && id.startsWith(`${PREFIX}:`) ? id : null;
}

/** Bytes of parsed tables kept, before the budget has its say. */
const TUNED_BYTES = 32 * 2 ** 20;

/** Parsed LUTs by id, oldest use first. */
const tables = new Map<string, { lut: ParsedLut; bytes: number }>();
let held = 0;
holdMemory("lutTables", () => held);

function remember(id: string, lut: ParsedLut): void {
  const bytes = lutBytes(lut);
  forget(id);
  const cap = allowance("lutTables", TUNED_BYTES);
  for (const [oldest, entry] of tables) {
    if (held + bytes <= cap) break;
    tables.delete(oldest);
    held -= entry.bytes;
  }
  tables.set(id, { lut, bytes });
  held += bytes;
}

function forget(id: string): void {
  const hit = tables.get(id);
  if (!hit) return;
  tables.delete(id);
  held -= hit.bytes;
}

/** A parsed LUT already in hand, bumped to most recently used. */
export function cachedLut(id: string): ParsedLut | undefined {
  const hit = tables.get(id);
  if (!hit) return undefined;
  tables.delete(id);
  tables.set(id, hit);
  return hit.lut;
}

const loading = new Map<string, Promise<ParsedLut>>();

/** The parsed LUT for a grade id, read out of the built-in set or off
 * whichever shelf holds it. Fails when neither has it, naming the id. */
export function loadLibraryLut(id: string): Promise<ParsedLut> {
  const hit = cachedLut(id);
  if (hit) return Promise.resolve(hit);
  let pending = loading.get(id);
  if (pending) return pending;
  pending = loadLibraryLutFile(id)
    .then(({ fileName, bytes }) => parseLutBytes(fileName, bytes))
    .then((lut) => {
      remember(id, lut);
      return lut;
    })
    .finally(() => loading.delete(id));
  loading.set(id, pending);
  return pending;
}

/** The LUT file itself, out of the built-in set or off whichever shelf holds
 * it: what an export stages beside its pictures so the engine parses the
 * same bytes the tab did. Fails naming the id when nothing in reach has it. */
export async function loadLibraryLutFile(id: string): Promise<{ fileName: string; bytes: Uint8Array }> {
  const builtin = builtinLutOf(id);
  if (builtin) return { fileName: `${builtin.id}.cube`, bytes: new Uint8Array(await builtinBytes(builtin)) };
  const item = listLinked(PREFIX).find((i) => libraryLutId(i.key) === id);
  if (!item) throw new Error(`The LUT ${id} is not in the library.`);
  let lastError: unknown = null;
  for (const copy of item.copies) {
    try {
      const bytes = await linkedBytes({ id: copy.assetId, fileName: copy.fileName, residency: copy.residency });
      return { fileName: copy.fileName, bytes: new Uint8Array(bytes) };
    } catch (e) {
      lastError = e; // That shelf isn't answering; another copy may still serve.
    }
  }
  const why = lastError instanceof Error ? ` ${lastError.message}` : "";
  throw new Error(`The LUT "${item.label}" could not be read.${why}`);
}

/** A built-in LUT's bytes, off the site: same-origin in the page, the bound
 * session's origin in a headless run. */
async function builtinBytes(l: BuiltinLut): Promise<ArrayBuffer> {
  const res = await cloudRequest(l.file);
  if (!res.ok) throw new Error(`The built-in LUT "${l.label}" could not be fetched (${res.status}).`);
  return res.arrayBuffer();
}

/** The built-in LUT a grade id names. */
export function builtinLutOf(id: string): BuiltinLut | undefined {
  return id.startsWith(`${PREFIX}:`) ? builtinLutByKey(id.slice(PREFIX.length + 1)) : undefined;
}

/** One LUT a grade can name, as a menu or the chat lists it. */
export interface LutChoice {
  id: string;
  label: string;
  builtIn: boolean;
}

let choices: { from: LinkedItem[]; list: LutChoice[] } | null = null;

/** Every LUT a grade can name: the built-in set, then the account's files
 * that are not one of them. Held until the shelf listing changes. */
export function listLutChoices(): LutChoice[] {
  const shelf = listLinked(PREFIX);
  if (choices?.from === shelf) return choices.list;
  const list: LutChoice[] = [
    ...BUILTIN_LUTS.map((l) => ({ id: libraryLutId(l.key), label: l.label, builtIn: true })),
    ...shelf
      .filter((i) => !builtinLutByKey(i.key))
      .map((i) => ({ id: libraryLutId(i.key), label: i.label, builtIn: false })),
  ];
  choices = { from: shelf, list };
  return list;
}

/** What a LUT id is called, or undefined when nothing in reach answers to it. */
export function lutLabel(id: string): string | undefined {
  return listLutChoices().find((c) => c.id === id)?.label;
}

/** The LUT kind as the registry holds it. */
export const lutKind: LinkedKind = {
  prefix: PREFIX,
  type: "lut",
  lazy: true,
  matches: isLutFile,
  accept: LUT_ACCEPT,
  extract: (doc: ProjectDoc) => {
    const ids = new Set<string>();
    const take = (grade: ColorGrade | undefined) => {
      const id = lutIdOf(grade);
      if (id) ids.add(id);
    };
    for (const c of doc.clips ?? []) take(c.grade);
    for (const t of doc.templates ?? []) {
      take(t.grade);
      for (const l of t.layers ?? []) take(l.grade);
    }
    return [...ids];
  },
  drop: (keys) => {
    for (const key of keys) forget(libraryLutId(key));
  },
};
registerLinkedKind(lutKind);

/** The account's LUTs, one entry per file however many shelves hold it. */
export const listLibraryLuts = (): LinkedItem[] => listLinked(PREFIX);
