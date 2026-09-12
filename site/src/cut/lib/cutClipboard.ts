// What a ⌘C / Ctrl+C leaves on the system clipboard, and what a ⌘V / Ctrl+V
// makes of it in another tab or another project.
//
// The text on the clipboard stays the mention tokens the chat composer reads.
// Beside it rides an HTML flavor carrying the copy itself: the timeline items
// whole, and the assets they play — or, for a card copied off a panel, the
// assets alone. A paste in the project the copy came from lands the items as
// a same-tab paste does; a paste in another project first brings the media
// across from wherever that project lives (this browser's storage, the Mac's
// engine, the cloud), remembers where each copy came from so the next paste
// finds it, and then lands the items on the copies.

import { refFromAsset } from "./assetRef";
import { trackEditorTool } from "./editorWork";
import { clipboardItemAcross, clipboardItemAssetIds, type TimelineClipboardItem } from "./itemKinds";
import type { LibraryData } from "./library";
import { landReferenceAssets, openReference } from "./projectReference";
import { placeRefAtPlayhead } from "./refPlace";
import { storedAssets, useEditor } from "./store";
import type { MediaAsset, StoredAsset } from "./types";

export interface CutClipboardPayload {
  v: 1;
  /** The project the copy was made in. */
  projectId: string;
  /** Timeline items, when the copy was a selection; empty for a card copy. */
  items: TimelineClipboardItem[];
  /** Every asset the items play — footage, sound, stickers, the fonts titles
   * are set in — or the copied cards themselves. */
  assets: StoredAsset[];
}

const ATTR = "data-donkeycut";

/** The assets a set of copied items reaches once they leave the project:
 * their media, their fonts — each kind says where its ids sit. */
export function payloadAssets(items: TimelineClipboardItem[], assets: MediaAsset[]): StoredAsset[] {
  const ids = new Set<string>();
  for (const cb of items) for (const id of clipboardItemAssetIds(clipboardItemAcross(cb, (id) => id))) ids.add(id);
  return storedAssets(assets.filter((a) => ids.has(a.id)));
}

const toBase64 = (text: string): string => {
  const bytes = new TextEncoder().encode(text);
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
};

const fromBase64 = (b64: string): string =>
  new TextDecoder().decode(Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)));

const escapeHtml = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** The HTML flavor: the tokens as visible text, the payload on the element.
 * Base64 keeps the JSON clear of every re-serialization the clipboard does
 * to markup on its way through the OS. */
export const clipboardHtml = (text: string, payload: CutClipboardPayload): string =>
  `<span ${ATTR}="${toBase64(JSON.stringify(payload))}">${escapeHtml(text)}</span>`;

/** The payload out of pasted HTML, or null for markup that is not ours. */
export function payloadFromHtml(html: string | null | undefined): CutClipboardPayload | null {
  if (!html) return null;
  const m = html.match(new RegExp(`${ATTR}="([A-Za-z0-9+/=]+)"`));
  if (!m) return null;
  try {
    const p = JSON.parse(fromBase64(m[1])) as Partial<CutClipboardPayload>;
    if (p.v !== 1 || typeof p.projectId !== "string" || !Array.isArray(p.items) || !Array.isArray(p.assets)) return null;
    return { v: 1, projectId: p.projectId, items: p.items, assets: p.assets };
  } catch {
    return null;
  }
}

/** Put a copy on the system clipboard: the tokens as text, the payload in
 * the HTML flavor. A browser without `ClipboardItem` takes the text alone,
 * and the copy pastes within its own tab from the timeline clipboard. */
export async function writeCutClipboard(text: string, payload: CutClipboardPayload | null): Promise<void> {
  const clip = navigator.clipboard;
  if (!clip) return;
  if (payload && typeof ClipboardItem !== "undefined" && typeof clip.write === "function") {
    const html = clipboardHtml(text, payload);
    await clip.write([
      new ClipboardItem({
        "text/plain": new Blob([text], { type: "text/plain" }),
        "text/html": new Blob([html], { type: "text/html" }),
      }),
    ]);
    return;
  }
  await clip.writeText(text);
}

/** The items on this project's assets: what crosses, on the copies' ids. */
const remapItems = (items: TimelineClipboardItem[], idMap: Map<string, string>): TimelineClipboardItem[] =>
  items.map((cb) => clipboardItemAcross(cb, (id) => idMap.get(id) ?? id));

/**
 * Land a pasted payload in the open project at `at`. Same project: the items
 * go through the timeline clipboard, the way a copy made here pastes; a card
 * copy is left to the mention tokens beside it. Another project: the assets
 * come across first (a copy already here is found by where it came from),
 * then the items land on them, or the cards land the way their + button
 * lands them. False when nothing here was pasted.
 */
export async function pasteCutPayload(
  payload: CutClipboardPayload,
  ctx: { projectId: string; at: number; library: LibraryData }
): Promise<boolean> {
  const { projectId, at, library } = ctx;
  const s = useEditor.getState();
  if (s.projectId !== projectId) return false;
  if (payload.projectId === projectId) {
    if (payload.items.length === 0) return false;
    s.setClipboard(payload.items);
    return s.paste();
  }
  // The editor holds this project open until the copies have landed, the way
  // it waits for a chat tool; a switch that beats the hold leaves the
  // landing refused with the project it was for.
  const landed = await trackEditorTool(async () => {
    const ref = await openReference({ kind: "project", id: payload.projectId });
    return landReferenceAssets(ref, payload.assets, projectId);
  });
  if (useEditor.getState().projectId !== projectId) return false;
  if (payload.items.length === 0) {
    let placed = false;
    for (const l of landed) {
      if (l.asset.type === "font") continue;
      if (await placeRefAtPlayhead(refFromAsset(l.asset), { projectId, library, at })) placed = true;
    }
    return placed || landed.length > 0;
  }
  const idMap = new Map(landed.map((l) => [l.sourceId, l.asset.id]));
  const st = useEditor.getState();
  st.setClipboard(remapItems(payload.items, idMap));
  return st.paste();
}
