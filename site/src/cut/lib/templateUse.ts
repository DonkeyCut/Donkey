// Templates become projects, and projects become templates.
//
// A gallery template is copied to wherever new projects land for the person:
// the cloud copies its media server-side from Donkey's storage (quota-exempt,
// nothing passes through the page); the Mac engine and the browser store take
// the bytes through the page, the same cross-backend copy a project move uses.
// A person's own template is a project of theirs marked as one, so using it,
// or making one, is a duplicate on the same shelf with the mark changed.
import { creatorLocale, creatorNames } from "./defaultNames";
import { cloudRequest, quotaError } from "./backend/cloud";
import { templateBackendFor } from "./backend/shared";
import { copyProjectAcross } from "./projectCopy";
import type { Residency } from "./residency";
import { backendFor } from "./residency";
import {
  COPY_PROGRESS_TYPE,
  TEMPLATE_SEARCH_API,
  TEMPLATES_API,
  type CopyProgressLine,
  type GalleryTemplate,
  type TemplateCandidate,
  type TemplateIndex,
  type TemplateMatch,
} from "./templateGallery";
import { isLinkedAssetType, type MediaFolder, type ProjectDoc, type ProjectKind, type StoredAsset } from "./types";
import { errorFromBody, UserError } from "./userError";

/** How often a cloud duplicate's job is asked whether it has landed. */
const COPY_POLL_MS = 1500;

const COPY_FAILED = new UserError("template_use_failed", "Could not create the project.");
// A Mac engine from before templates saves the copy without its mark.
const ENGINE_STALE = new UserError("template_needs_update", "Update the Donkey app to make templates on this Mac.");

/** The published gallery, read from the hosted site wherever the page runs. */
export async function fetchTemplateIndex(): Promise<TemplateIndex> {
  const res = await cloudRequest(TEMPLATES_API);
  if (!res.ok) {
    throw new UserError("templates_read_failed", "Could not read the templates.");
  }
  return (await res.json()) as TemplateIndex;
}

const SEARCH_FAILED = new UserError("template_search_failed", "Template search isn't available right now.");

/** The templates that fit a description, best first: the gallery's, and any
 * of the person's own sent along. */
export async function searchTemplateIndex(query: string, own: TemplateCandidate[] = []): Promise<TemplateMatch[]> {
  const res = await cloudRequest(TEMPLATE_SEARCH_API, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query, own }),
  });
  const body = (await res.json().catch(() => ({}))) as { matches?: TemplateMatch[] };
  if (!res.ok) {
    throw errorFromBody(body, SEARCH_FAILED);
  }
  return body.matches ?? [];
}

/** Make a new project from a gallery template in `target` and return its id. */
export async function copyTemplate(
  template: GalleryTemplate,
  target: Residency,
  name: string,
  onProgress?: (done: number, total: number) => void
): Promise<string> {
  // A template carries no conversations, so none travel.
  const id =
    target === "cloud"
      ? await copyToCloud(template, name, onProgress)
      : await copyProjectAcross(templateBackendFor(template.id), backendFor(target), template.id, {
          rename: () => name,
          onProgress,
          chats: "skip",
        });
  await fileOrDrop(target, id);
  return id;
}

/** Whether the Media panel lists an asset at its top level: a person's
 * import (nothing made by the app) that no folder holds yet. Fonts and LUTs
 * live in their own menus. */
const unfiledMedia = (a: StoredAsset) => a.origin == null && !isLinkedAssetType(a.type) && !a.folderId;

/**
 * File a new project's template media in one Media folder, "Template Assets",
 * so the person's own imports land beside it and never mix in. Media the
 * template already kept in a folder stays there. The doc goes back through
 * the same project route on every shelf, so the browser, the Mac and the
 * cloud each write it their own way.
 */
async function fileTemplateMedia(r: Residency, projectId: string): Promise<void> {
  const backend = backendFor(r);
  const res = await backend.fetch(`/api/cut/projects/${projectId}`);
  if (!res.ok) {
    throw COPY_FAILED;
  }
  const doc = (await res.json()) as ProjectDoc;
  if (!doc.assets.some(unfiledMedia)) {
    return;
  }
  const folder: MediaFolder = { id: crypto.randomUUID(), name: creatorNames().templateAssets, createdAt: Date.now() };
  const saved = await backend.fetch(`/api/cut/projects/${projectId}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      mediaFolders: [...(doc.mediaFolders ?? []), folder],
      assets: doc.assets.map((a) => (unfiledMedia(a) ? { ...a, folderId: folder.id } : a)),
    }),
  });
  if (!saved.ok) {
    throw COPY_FAILED;
  }
}

/** File a fresh copy's template media, or delete the copy when that fails,
 * so a half-made project never lists. */
async function fileOrDrop(r: Residency, projectId: string): Promise<void> {
  try {
    await fileTemplateMedia(r, projectId);
  } catch (e) {
    await backendFor(r)
      .fetch(`/api/cut/projects/${projectId}`, { method: "DELETE" })
      .catch(() => undefined);
    throw e;
  }
}

/** Copy a gallery template into the account's cloud. The server copies the
 * media and streams a line as each file lands, so the page shows the count
 * while it waits. A refusal before the copy starts (sign-in, the project
 * limit) answers as a plain error body. */
async function copyToCloud(
  template: GalleryTemplate,
  name: string,
  onProgress?: (done: number, total: number) => void
): Promise<string> {
  const res = await cloudRequest(`${TEMPLATES_API}/${encodeURIComponent(template.id)}/copy`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: COPY_PROGRESS_TYPE },
    body: JSON.stringify({ name }),
  });
  if (!res.ok || !res.body) {
    throw errorFromBody(await res.json().catch(() => null), COPY_FAILED.message);
  }

  // Read the lines as they arrive; the last one names the project or the
  // failure.
  const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
  let pending = "";
  for (;;) {
    const { value, done } = await reader.read();
    pending += value ?? "";
    const lines = pending.split("\n");
    pending = done ? "" : (lines.pop() ?? "");
    for (const raw of lines) {
      if (!raw.trim()) {
        continue;
      }
      const line = JSON.parse(raw) as CopyProgressLine;
      if ("projectId" in line) {
        return line.projectId;
      }
      if ("error" in line) {
        throw errorFromBody(line, COPY_FAILED.message);
      }
      onProgress?.(line.done, line.total);
    }
    if (done) {
      throw COPY_FAILED;
    }
  }
}

/** Duplicate a project on its own shelf and return the copy's id. The cloud
 * queues its copies, so its answer is a job polled until it lands; the engine
 * and the browser store answer with the copy itself. */
async function duplicateOnShelf(r: Residency, id: string): Promise<string> {
  const backend = backendFor(r);
  const res = await backend.fetch(`/api/cut/projects/${id}/duplicate`, {
    method: "POST",
    body: JSON.stringify({ locale: creatorLocale() }),
  });
  const body = (await res.json().catch(() => null)) as { id?: string; jobId?: string; error?: string } | null;
  if (!res.ok || (!body?.id && !body?.jobId)) {
    throw quotaError(res.status, body) ?? errorFromBody(body, COPY_FAILED.message);
  }
  if (body.id) {
    return body.id;
  }
  for (;;) {
    await new Promise((done) => setTimeout(done, COPY_POLL_MS));
    const st = await backend.fetch(`/api/cut/copy-jobs/${body.jobId}`);
    if (!st.ok) {
      throw COPY_FAILED;
    }
    const job = (await st.json()) as { state: string; newProjectId?: string };
    if (job.state === "done" && job.newProjectId) {
      return job.newProjectId;
    }
    if (job.state === "error") {
      throw errorFromBody(job, COPY_FAILED.message);
    }
  }
}

/** Mark a fresh copy `kind`, named `name`, at the top of its shelf, and check
 * the mark held. */
async function markCopy(r: Residency, copyId: string, kind: ProjectKind, name: string) {
  const backend = backendFor(r);

  // A duplicate lands beside its source; a template and the project made from
  // it both start at the top level.
  const moved = await backend.fetch(`/api/cut/projects/${copyId}/move`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ folderId: null }),
  });
  if (!moved.ok) {
    throw COPY_FAILED;
  }
  const res = await backend.fetch(`/api/cut/projects/${copyId}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ kind, name }),
  });
  if (!res.ok) {
    throw COPY_FAILED;
  }

  // An engine that predates the mark drops it; the saved doc says which.
  const saved = await backend.fetch(`/api/cut/projects/${copyId}`);
  if (!saved.ok) {
    throw COPY_FAILED;
  }
  const doc = (await saved.json()) as { kind?: ProjectKind };
  if ((doc.kind ?? "project") !== kind) {
    throw ENGINE_STALE;
  }
}

/** A copy of a project on its shelf, marked `kind` and named `name`: a
 * project made into a template, or a template made into a new project. A copy
 * that cannot be marked is deleted, so a half-made template never lists as a
 * project. */
export async function copyAsKind(r: Residency, id: string, kind: ProjectKind, name: string): Promise<string> {
  const copyId = await duplicateOnShelf(r, id);
  try {
    await markCopy(r, copyId, kind, name);
    // A project made from a template keeps the template's media together.
    if (kind === "project") {
      await fileTemplateMedia(r, copyId);
    }
  } catch (e) {
    await backendFor(r)
      .fetch(`/api/cut/projects/${copyId}`, { method: "DELETE" })
      .catch(() => undefined);
    throw e;
  }
  return copyId;
}
