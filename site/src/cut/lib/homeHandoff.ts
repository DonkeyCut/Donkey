// The first chat message a project is made with on Home.
//
// Home creates the project and opens the editor; the editor's chat sends the
// message once the panel mounts. The message waits in this tab's session
// storage under the new project's id, and the chat takes it exactly once: a
// reload of the editor finds nothing and sends nothing again.
import type { AssetRef } from "./assetRef";

/** What Home hands the editor's chat for one new project. */
export interface HomeHandoff {
  text: string;
  attachments: AssetRef[];
  model: string;
}

const KEY_PREFIX = "cut-home-handoff:";

const keyOf = (projectId: string) => `${KEY_PREFIX}${projectId}`;

/** This tab's session storage, or null where storage is blocked. */
function store(): Storage | null {
  try {
    return globalThis.sessionStorage ?? null;
  } catch {
    return null;
  }
}

/** Park the first message for `projectId` until its editor takes it. */
export function saveHomeHandoff(projectId: string, handoff: HomeHandoff): void {
  try {
    store()?.setItem(keyOf(projectId), JSON.stringify(handoff));
  } catch {
    // Storage full or blocked: the project still opens, without the message.
  }
}

/** Whether a message waits for `projectId`, without taking it. */
export function hasHomeHandoff(projectId: string): boolean {
  try {
    return store()?.getItem(keyOf(projectId)) != null;
  } catch {
    return false;
  }
}

/** Take the waiting message for `projectId`, once. A second call, or a call
 * for any other project, answers null. */
export function takeHomeHandoff(projectId: string): HomeHandoff | null {
  const storage = store();
  if (!storage) {
    return null;
  }

  // Remove before parsing, so even an unreadable entry is never seen twice.
  let raw: string | null;
  try {
    raw = storage.getItem(keyOf(projectId));
    storage.removeItem(keyOf(projectId));
  } catch {
    return null;
  }
  if (!raw) {
    return null;
  }

  return parseHandoff(raw);
}

/** A stored handoff, checked field by field; anything malformed reads as none. */
function parseHandoff(raw: string): HomeHandoff | null {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!value || typeof value !== "object") {
    return null;
  }

  const { text, attachments, model } = value as Record<string, unknown>;
  if (typeof text !== "string" || typeof model !== "string" || !Array.isArray(attachments)) {
    return null;
  }

  const refs = attachments.filter(isRefShaped);
  if (!text.trim() && refs.length === 0) {
    return null;
  }
  return { text, attachments: refs, model };
}

/** A stored ref keeps every field it was saved with (a font's tool call, a
 * template's kind), so it is checked for the fields every ref has and kept
 * whole. */
function isRefShaped(v: unknown): v is AssetRef {
  if (!v || typeof v !== "object") {
    return false;
  }
  const o = v as Record<string, unknown>;
  return ["scope", "id", "name", "kind", "url"].every((k) => typeof o[k] === "string" && o[k] !== "");
}
