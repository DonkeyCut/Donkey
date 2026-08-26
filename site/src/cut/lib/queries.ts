"use client";

/**
 * The home surfaces' data layer: the projects listing per residency and the
 * library listing for the active backend.
 *
 * Both are read on every visit and change rarely, so they are cached twice
 * over. TanStack Query holds them for the life of the tab, which is what makes
 * project → back → project instant; a snapshot in IndexedDB carries the last
 * answer across reloads, so even a cold load paints the shelf it painted last
 * time. Neither is ever waited on: the live request goes out regardless and
 * replaces whatever was showing.
 *
 * Mutations edit the cached lists in place through the patch helpers rather
 * than refetching, so a rename or a move lands on screen in the same frame the
 * user asked for it.
 */

import { useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { useEffect } from "react";

import { engineLost } from "./api";
import { cutMode } from "./backend";
import { useCutMode } from "./backend/hooks";
import { readSnapshot, snapshotKey, writeSnapshot } from "./cache";
import { fetchLibrary, type LibraryData } from "./library";
import { fetchNotes, type NotesData } from "./notes";
import {
  availableResidencies,
  backendFor,
  listedResidencies,
  projectsSnapshotKey,
  type Residency,
} from "./residency";
import type { ProjectFolder, ProjectSummary } from "./types";

export { backendFor };
export type { Residency };

export type ProjectsSection = { projects: ProjectSummary[]; folders: ProjectFolder[] };

export const projectsKey = (r: Residency) => ["cut", "projects", r] as const;
/** The library listing spans every shelf the user has, so the set itself is
 * the cache key — connecting the engine mid-session widens the shelf rather
 * than repainting a stale half of it. A recalled shelf keys apart from a live
 * one (`local!`), so the app answering re-reads it instead of holding on to
 * the memory. */
export const libraryScope = () => {
  const live = availableResidencies();
  return listedResidencies()
    .map((r) => (live.includes(r) ? r : `${r}!`))
    .join("+");
};
export const libraryKey = (scope: string) => ["cut", "library", scope] as const;

/**
 * Paint the last answer we stored while the live one is in flight. The
 * snapshot is backdated to when it was taken, so the query still counts as
 * stale and the request already on its way is the one that wins; a live
 * answer that beat the disk read is never overwritten.
 */
function seedFromSnapshot<T>(client: QueryClient, queryKey: readonly unknown[], cacheKey: string) {
  let alive = true;
  void readSnapshot<T>(cacheKey).then((hit) => {
    if (!alive || !hit || client.getQueryData(queryKey) !== undefined) return;
    client.setQueryData(queryKey, hit.value, { updatedAt: hit.at });
  });
  return () => {
    alive = false;
  };
}

async function fetchProjectsSection(r: Residency): Promise<ProjectsSection> {
  const backend = backendFor(r);
  const [res, fres] = await Promise.all([
    backend.fetch("/api/cut/projects"),
    backend.fetch("/api/cut/projects/folders"),
  ]);
  if (!res.ok) throw new Error(String(res.status));
  return {
    projects: (await res.json()) as ProjectSummary[],
    folders: fres.ok ? ((await fres.json()) as ProjectFolder[]) : [],
  };
}

/**
 * One residency's projects and folders. Errors surface as `isError` rather
 * than an empty list, so one backend failing never blanks the other's cards.
 *
 * Listing a shelf and reading it are separate: the Mac's shelf lists with the
 * Donkey app closed, off the snapshot alone, because those projects still
 * exist and the user is entitled to see them. `live` is what asks the backend
 * for a fresh answer, and it turns on by itself the moment the app connects.
 */
export function useProjectsSection(r: Residency, { list, live }: { list: boolean; live: boolean }) {
  const client = useQueryClient();

  useEffect(() => {
    if (!list) return;
    return seedFromSnapshot<ProjectsSection>(client, projectsKey(r), projectsSnapshotKey(r));
  }, [client, r, list]);

  return useQuery<ProjectsSection>({
    enabled: list && live,
    queryKey: projectsKey(r),
    queryFn: async () => {
      try {
        const data = await fetchProjectsSection(r);
        writeSnapshot(projectsSnapshotKey(r), data);
        return data;
      } catch (err) {
        if (r === "local" && cutMode() === "local") {
          // The engine this app is running on stopped answering; the
          // ConnectGate falls back to the cloud and says so. A cloud-bound app
          // whose local shelf hiccups keeps running — that failure is one
          // section's error, not the ground moving.
          engineLost();
        }
        throw err;
      }
    },
    // The listing is cheap to re-read and its cards carry edit times and
    // sizes, so every visit revalidates — behind the cached paint, never a
    // spinner.
    staleTime: 0,
    refetchOnMount: "always",
    retry: false,
    // A section stuck on "Couldn't load these projects" heals itself.
    refetchInterval: (q) => (q.state.status === "error" ? 3000 : false),
  });
}

/** How often a live library listing re-reads. Long enough that an open tab is
 * cheap, short enough that a clip finishing its upload from the phone lands on
 * screen while the user is still looking at the page. */
const LIBRARY_LIVE_MS = 6000;

/** The user's whole shelf: every residency's library, merged — including the
 * one this browser can only remember.
 *
 * `live` keeps the listing current while the page is open: the surfaces fed
 * from another device — the Camera Roll, filled by the iOS app — poll on a
 * timer and re-read the moment the window comes back to the front, so a
 * recording made on the phone shows up here without a reload. The timer only
 * runs while this tab is the focused one. */
export function useLibrary({ live = false }: { live?: boolean } = {}) {
  // Not read for the query itself — the backend binding decides which
  // residencies are reachable, so a mode change re-keys and re-reads.
  useCutMode();
  const client = useQueryClient();
  const scope = libraryScope();
  const snap = snapshotKey(scope, "library");

  useEffect(
    () => seedFromSnapshot<LibraryData>(client, libraryKey(scope), snap),
    [client, scope, snap]
  );

  return useQuery<LibraryData>({
    queryKey: libraryKey(scope),
    queryFn: async () => {
      const data = await fetchLibrary({ remembered: true });
      writeSnapshot(snap, data);
      return data;
    },
    staleTime: 0,
    refetchOnMount: "always",
    refetchOnWindowFocus: live,
    refetchInterval: live ? LIBRARY_LIVE_MS : false,
    retry: false,
  });
}

/** Drop a read already on the wire for this key, so its answer — taken before
 * the mutation the caller is about to apply — never lands on top of the edit.
 * A live listing is re-reading on a timer, and a delete applied while one of
 * those reads was in the air used to see the deleted item reappear.
 *
 * Only once the key holds something: the first load has nothing to overwrite,
 * and stopping it would leave the page empty until the next trigger. */
function stopReads(client: QueryClient, queryKey: readonly unknown[]) {
  if (client.getQueryData(queryKey) === undefined) return;
  void client.cancelQueries({ queryKey }, { revert: false });
}

/** Edit a residency's cached listing in place — the optimistic half of every
 * projects mutation. The snapshot moves with it, so a reload right after a
 * rename shows the new name and never flashes the old one back. */
export function patchProjects(
  client: QueryClient,
  r: Residency,
  fn: (prev: ProjectsSection) => ProjectsSection
) {
  stopReads(client, projectsKey(r));
  const next = client.setQueryData<ProjectsSection>(projectsKey(r), (prev) =>
    prev ? fn(prev) : prev
  );
  if (next) writeSnapshot(projectsSnapshotKey(r), next);
}

/** The library's equivalent. Its items carry their own residency, so one
 * merged listing is patched however the mutation asks. */
export function patchLibrary(client: QueryClient, fn: (prev: LibraryData) => LibraryData) {
  const scope = libraryScope();
  stopReads(client, libraryKey(scope));
  const next = client.setQueryData<LibraryData>(libraryKey(scope), (prev) =>
    prev ? fn(prev) : prev
  );
  if (next) writeSnapshot(snapshotKey(scope, "library"), next);
}

/** Pull a residency's listing again — for the changes only the server can
 * describe, like the size and duration a duplicate came out at. */
export function refetchProjects(client: QueryClient, r: Residency) {
  return client.invalidateQueries({ queryKey: projectsKey(r) });
}

export function refetchLibrary(client: QueryClient) {
  return client.invalidateQueries({ queryKey: libraryKey(libraryScope()) });
}

// --- Phone surfaces: the iOS link flag and synced notes ---

const PHONE_KEY = ["cut", "phone"] as const;
// Scoped to the account: two people signing in on one Mac must not read each
// other's answer.
const phoneSnapshot = () => snapshotKey("cloud", "phone");

/** Whether this account has been seen from the iOS app. Gates the mobile
 * surfaces (Camera Roll, Notes) in the home sidebar; an account that never
 * signed in on a phone keeps the desktop exactly as it was.
 *
 * Asked once per tab: the flag only ever turns on, and the sidebar unmounts
 * every time a project opens, so a second read would only cost the two rows a
 * blink on the way back. The snapshot carries the last answer across reloads,
 * so a cold load draws the same sidebar it drew last time. */
export function usePhoneLink() {
  const client = useQueryClient();
  useEffect(
    () => seedFromSnapshot<boolean>(client, PHONE_KEY, phoneSnapshot()),
    [client]
  );
  const query = useQuery<boolean>({
    queryKey: PHONE_KEY,
    queryFn: async () => {
      const res = await backendFor("cloud").fetch("/api/cut/phone");
      if (!res.ok) throw new Error(String(res.status));
      const linked = ((await res.json()) as { linked?: boolean }).linked === true;
      writeSnapshot(phoneSnapshot(), linked);
      return linked;
    },
    staleTime: Infinity,
    retry: false,
  });
  return query.data === true;
}

export const notesKey = ["cut", "notes"] as const;
// The snapshot carries the notes with their folders and labels; the key moves
// with that shape so a page holding an old shape never paints from it.
const NOTES_SNAPSHOT = "cut-notes-v3";

/** The account's synced notes and their folders, phone and desktop edits
 * merged server-side. */
export function useNotes() {
  const client = useQueryClient();
  useEffect(() => seedFromSnapshot<NotesData>(client, notesKey, NOTES_SNAPSHOT), [client]);
  return useQuery<NotesData>({
    queryKey: notesKey,
    queryFn: async () => {
      const data = await fetchNotes();
      writeSnapshot(NOTES_SNAPSHOT, data);
      return data;
    },
    staleTime: 0,
    refetchOnMount: "always",
    retry: false,
  });
}

/** Optimistic edit of the cached notes, snapshot moving with it. */
export function patchNotes(client: QueryClient, fn: (prev: NotesData) => NotesData) {
  const next = client.setQueryData<NotesData>(notesKey, (prev) => (prev ? fn(prev) : prev));
  if (next) writeSnapshot(NOTES_SNAPSHOT, next);
}
