"use client";

import { useCallback, useState } from "react";

import { openCutDb } from "./cache";

/**
 * Per-project view state (zoom level, timeline panel height) — how this
 * browser looks at a project, not part of the cut. Stored in IndexedDB
 * keyed by project id; project.json only carries real content.
 *
 * Cross-project view prefs (active side-panel tab, segment choices) live in
 * localStorage via useLocalPref below.
 */
export interface ProjectUiState {
  pxPerSec?: number;
  timelineH?: number;
}

const STORE = "project-ui";

export async function loadUiState(projectId: string): Promise<ProjectUiState> {
  try {
    const db = await openCutDb();
    return await new Promise((resolve) => {
      const req = db.transaction(STORE).objectStore(STORE).get(projectId);
      req.onsuccess = () => resolve((req.result as ProjectUiState) ?? {});
      req.onerror = () => resolve({});
    });
  } catch {
    return {}; // e.g. private-mode quota — fall back to defaults
  }
}

// Writes are debounced and merged so slider drags don't hammer the store.
let pending: { projectId: string; patch: ProjectUiState } | null = null;
let timer: ReturnType<typeof setTimeout> | null = null;

async function flush() {
  const job = pending;
  pending = null;
  if (!job) return;
  try {
    const db = await openCutDb();
    const tx = db.transaction(STORE, "readwrite");
    const store = tx.objectStore(STORE);
    const req = store.get(job.projectId);
    req.onsuccess = () =>
      store.put({ ...((req.result as ProjectUiState) ?? {}), ...job.patch }, job.projectId);
  } catch {
    // View state is best-effort; losing it only resets zoom/height defaults.
  }
}

export function saveUiState(projectId: string, patch: ProjectUiState) {
  if (pending && pending.projectId !== projectId) void flush();
  pending = { projectId, patch: { ...(pending?.patch ?? {}), ...patch } };
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => void flush(), 300);
}

/**
 * useState that survives reloads via localStorage. `accept` guards against
 * stale stored values (a tab or folder that no longer exists falls back to
 * the default). Reads synchronously on mount, so use it only in components
 * that mount client-side (everything inside the editor does).
 */
export function useLocalPref<T>(
  key: string,
  fallback: T,
  accept: (v: unknown) => boolean
): [T, (v: T) => void] {
  const [value, setValue] = useState<T>(() => {
    if (typeof window === "undefined") return fallback;
    try {
      const raw = localStorage.getItem(key);
      if (raw === null) return fallback;
      const parsed = JSON.parse(raw) as unknown;
      return accept(parsed) ? (parsed as T) : fallback;
    } catch {
      return fallback;
    }
  });
  const set = useCallback(
    (v: T) => {
      setValue(v);
      try {
        localStorage.setItem(key, JSON.stringify(v));
      } catch {
        // Private-mode quota — the choice just won't stick across reloads.
      }
    },
    [key]
  );
  return [value, set];
}
