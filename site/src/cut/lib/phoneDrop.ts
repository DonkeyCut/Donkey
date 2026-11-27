// Upload from phone, the computer's half. The Upload dialog opens a drop for
// one place and shows its code; the phone sends to R2 staging; this module
// takes each staged file into its place through the import the place already
// uses, then lets the staged copy go. Drops for cloud places land on any of
// the account's computers; a Mac's or a browser's place lands only in the
// browser that opened it, which the client id below names.
//
// The routes are hosted-only, so these calls go to /api/cut-cloud whatever
// the open project's residency.
import type { QueryClient } from "@tanstack/react-query";

import { cloudRequest } from "./backend/cloud";
import type { Residency } from "./residency";
import { dismissLibraryImport, importLibraryFiles, useLibraryImports } from "./libraryIntake";
import { assetTypeOf } from "./media";

export type PhoneTarget =
  | { kind: "library"; residency: Residency; folderId: string | null }
  | { kind: "project"; residency: Residency; projectId: string; folderId: string | null };

export type PhoneFileState = "sending" | "staged" | "claimed" | "landed" | "failed";

/** One file of an open drop, as the dialog draws it. */
export type PhoneDropFile = {
  id: string;
  name: string;
  mime: string;
  bytes: number;
  sentBytes: number;
  state: PhoneFileState;
  device: string;
  thumbUrl: string | null;
};

export type PhoneDropBeat = { open: boolean; phones: number; files: PhoneDropFile[] };

/** A staged file this computer can take, and files still on their way. */
type InboxFile = { id: string; dropId: string; name: string; mime: string; bytes: number; target: PhoneTarget };
type InboxSending = { id: string; dropId: string; name: string; mime: string; target: PhoneTarget };
type Inbox = { files: InboxFile[]; sending: InboxSending[] };

/** What became of a file a lander took: in its place, refused for good (the
 * staged copy goes), or not there yet (the staged copy waits for another pass). */
export type PhoneLanding = "landed" | "refused" | "again";

/** Takes one file into its place and says how that went. */
export type PhoneLander = (file: File, folderId: string | null) => Promise<PhoneLanding>;

const BASE = "/api/cut-cloud/phone";
const CLIENT_KEY = "cut-phone-client";
/** How often the inbox is read while a phone is still sending to this computer. */
const INBOX_POLL_MS = 3000;

const post = (path: string, body?: unknown) =>
  cloudRequest(`${BASE}${path}`, {
    method: "POST",
    headers: body === undefined ? undefined : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

// --- This browser's id ---

let memoryClientId: string | null = null;

/** A random id for this browser, kept across reloads where storage allows. */
export function phoneClientId(): string {
  try {
    const kept = localStorage.getItem(CLIENT_KEY);
    if (kept) {
      return kept;
    }
    const fresh = crypto.randomUUID();
    localStorage.setItem(CLIENT_KEY, fresh);
    return fresh;
  } catch {
    memoryClientId ??= crypto.randomUUID();
    return memoryClientId;
  }
}

// --- The dialog's drop ---

/** Open a drop for one place. The QR carries `url`. */
export async function openPhoneDrop(target: PhoneTarget, label: string, count: "one" | "many") {
  const res = await post("/drops", { clientId: phoneClientId(), target, label, single: count === "one" });
  if (!res.ok) {
    throw new Error(`phone drop ${res.status}`);
  }
  const { id, code } = (await res.json()) as { id: string; code: string };
  return { id, url: `${window.location.origin}/up/${code}` };
}

/** Keep the code good, and read what the phone has sent. */
export async function beatPhoneDrop(id: string): Promise<PhoneDropBeat> {
  const res = await post(`/drops/${id}/alive`);
  if (!res.ok) {
    throw new Error(`phone drop ${res.status}`);
  }
  return (await res.json()) as PhoneDropBeat;
}

/** Retire the code. Files already sending finish and land. */
export function closePhoneDrop(id: string) {
  void post(`/drops/${id}/close`).catch(() => {});
  wakePhoneLanding();
}

// --- Landing ---

let queryClient: QueryClient | null = null;
const projectLanders = new Map<string, PhoneLander>();
const dropLanders = new Map<string, PhoneLander>();
/** Placeholder tiles for library files a phone is still sending, by file id. */
const placeholders = new Set<string>();
let sendingListener: ((projectId: string, count: number) => void) | null = null;
let polling = false;
let rerun = false;

/** The app shell hands over the cache library imports patch. */
export function bindPhoneLanding(client: QueryClient) {
  queryClient = client;
  wakePhoneLanding();
}

/** The open editor takes files sent to its project. */
export function landProjectFiles(projectId: string, land: PhoneLander, onSending: (count: number) => void) {
  projectLanders.set(projectId, land);
  sendingListener = (id, count) => {
    if (id === projectId) {
      onSending(count);
    }
  };
  wakePhoneLanding();
  return () => {
    if (projectLanders.get(projectId) === land) {
      projectLanders.delete(projectId);
      sendingListener = null;
    }
  };
}

/** A dialog that lands its own drop a special way: Replace picks the file. */
export function landDropFiles(dropId: string, land: PhoneLander) {
  dropLanders.set(dropId, land);
  return () => {
    if (dropLanders.get(dropId) === land) {
      dropLanders.delete(dropId);
    }
  };
}

/** Read the inbox now, and keep reading while a phone is still sending here. */
export function wakePhoneLanding() {
  if (polling) {
    rerun = true;
    return;
  }
  polling = true;
  void pollInbox().finally(() => {
    polling = false;
  });
}

async function pollInbox() {
  for (;;) {
    rerun = false;
    const inbox = await readInbox();
    if (!inbox) {
      return;
    }
    showSending(inbox.sending);

    for (const file of inbox.files) {
      const land = landerFor(file);
      if (land) {
        await takeIn(file, land);
      }
    }

    // Keep looking while something is on its way, or a beat asked again.
    if (inbox.sending.length === 0 && !rerun) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, INBOX_POLL_MS));
  }
}

async function readInbox(): Promise<Inbox | null> {
  try {
    const res = await post("/inbox", { clientId: phoneClientId() });
    return res.ok ? ((await res.json()) as Inbox) : null;
  } catch {
    return null;
  }
}

/** Who takes a file in here, or null when nothing open here can. */
function landerFor(file: InboxFile): PhoneLander | null {
  const special = dropLanders.get(file.dropId);
  if (special) {
    return special;
  }
  if (file.target.kind === "project") {
    return projectLanders.get(file.target.projectId) ?? null;
  }
  const client = queryClient;
  if (!client) {
    return null;
  }
  const target = file.target;
  return (picked, folderId) => landInLibrary(picked, { residency: target.residency, folderId }, client);
}

/** Claim the file, fetch its bytes, hand them to the lander, settle. */
async function takeIn(file: InboxFile, land: PhoneLander) {
  const res = await post(`/files/${file.id}/claim`);
  if (!res.ok) {
    return;
  }
  const { url } = (await res.json()) as { url: string };
  clearPlaceholder(file.id);

  let landing: PhoneLanding;
  try {
    const bytes = await fetch(url);
    if (!bytes.ok) {
      throw new Error(`staged file ${bytes.status}`);
    }
    const blob = await bytes.blob();
    const picked = new File([blob], file.name, { type: file.mime || blob.type });
    landing = await land(picked, file.target.folderId);
  } catch {
    // A fetch that broke puts the file back for the next pass.
    landing = "again";
  }

  // A file that is not there yet keeps its staged copy for the next pass.
  if (landing === "again") {
    await post(`/files/${file.id}/release`).catch(() => {});
    return;
  }
  await post(`/files/${file.id}/${landing === "landed" ? "landed" : "failed"}`).catch(() => {});
}

/** The library's own import. Its tile keeps the file and a retry if saving
 * fails, so the staged copy can go either way. */
async function landInLibrary(
  file: File,
  target: { residency: Residency; folderId: string | null },
  client: QueryClient,
): Promise<PhoneLanding> {
  let landing: PhoneLanding = "refused";
  await importLibraryFiles([file], target, client, {
    prepared: () => {},
    landed: () => {
      landing = "landed";
    },
  });
  return landing;
}

/** Library files still on a phone get the tile an upload shows, in the folder
 * they go to; files for a project count into the editor's upload badge. */
function showSending(sending: InboxSending[]) {
  const live = new Set(sending.map((s) => s.id));
  for (const id of placeholders) {
    if (!live.has(id)) {
      clearPlaceholder(id);
    }
  }

  const perProject = new Map<string, number>();
  for (const s of sending) {
    if (s.target.kind === "project") {
      perProject.set(s.target.projectId, (perProject.get(s.target.projectId) ?? 0) + 1);
      continue;
    }
    if (placeholders.has(s.id) || dropLanders.has(s.dropId)) {
      continue;
    }
    placeholders.add(s.id);
    const target = s.target;
    useLibraryImports.setState((state) => ({
      items: [
        ...state.items,
        {
          id: placeholderId(s.id),
          name: s.name,
          folderId: target.folderId,
          residency: target.residency,
          mediaType: assetTypeOf(new File([], s.name, { type: s.mime })) ?? undefined,
          startedAt: Date.now(),
          stage: "uploading",
          startStage: "uploading",
          run: async () => {},
        },
      ],
    }));
  }
  for (const projectId of projectLanders.keys()) {
    sendingListener?.(projectId, perProject.get(projectId) ?? 0);
  }
}

const placeholderId = (fileId: string) => `phone:${fileId}`;

function clearPlaceholder(fileId: string) {
  if (!placeholders.delete(fileId)) {
    return;
  }
  dismissLibraryImport(placeholderId(fileId));
}
