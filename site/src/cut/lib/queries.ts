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
import { useCutMode } from "./backend/hooks";
import { readSnapshot, snapshotKey, writeSnapshot } from "./cache";
import { webModeEnabled } from "./flags";
import { fetchLibrary, type LibraryData } from "./library";
import { availableResidencies, backendFor, type Residency } from "./residency";
import type { ProjectFolder, ProjectSummary } from "./types";

export { backendFor };
export type { Residency };

export type ProjectsSection = { projects: ProjectSummary[]; folders: ProjectFolder[] };

export const projectsKey = (r: Residency) => ["cut", "projects", r] as const;
/** The library listing spans every reachable residency, so the set itself is
 * the cache key — connecting the engine mid-session widens the shelf rather
 * than repainting a stale half of it. */
export const libraryScope = () => availableResidencies().join("+");
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

/** One residency's projects and folders. Errors surface as `isError` rather
 * than an empty list, so one backend failing never blanks the other's cards. */
export function useProjectsSection(r: Residency, enabled: boolean) {
  const client = useQueryClient();

  useEffect(() => {
    if (!enabled) return;
    return seedFromSnapshot<ProjectsSection>(client, projectsKey(r), snapshotKey(r, "projects"));
  }, [client, r, enabled]);

  return useQuery<ProjectsSection>({
    enabled,
    queryKey: projectsKey(r),
    queryFn: async () => {
      try {
        const data = await fetchProjectsSection(r);
        writeSnapshot(snapshotKey(r, "projects"), data);
        return data;
      } catch (err) {
        if (r === "local" && !webModeEnabled()) {
          // The engine on this Mac stopped answering; the ConnectGate takes
          // the screen back over until it returns.
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

/** The user's whole shelf: every reachable residency's library, merged. */
export function useLibrary() {
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
      const data = await fetchLibrary();
      writeSnapshot(snap, data);
      return data;
    },
    staleTime: 0,
    refetchOnMount: "always",
    retry: false,
  });
}

/** Edit a residency's cached listing in place — the optimistic half of every
 * projects mutation. The snapshot moves with it, so a reload right after a
 * rename shows the new name rather than flashing the old one back. */
export function patchProjects(
  client: QueryClient,
  r: Residency,
  fn: (prev: ProjectsSection) => ProjectsSection
) {
  const next = client.setQueryData<ProjectsSection>(projectsKey(r), (prev) =>
    prev ? fn(prev) : prev
  );
  if (next) writeSnapshot(snapshotKey(r, "projects"), next);
}

/** The library's equivalent. Its items carry their own residency, so one
 * merged listing is patched however the mutation asks. */
export function patchLibrary(client: QueryClient, fn: (prev: LibraryData) => LibraryData) {
  const scope = libraryScope();
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
