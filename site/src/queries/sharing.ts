"use client";

import { useQuery } from "@tanstack/react-query";
import { requestSharing, shareEndpoint, type ShareResource } from "@/cut/lib/sharingClient";
import { apiFetch } from "@/queries/apiClient";
import type { SharedLibraryPage } from "@/cut/lib/librarySharing";

export const sharingKey = (resource: ShareResource) => ["sharing", shareEndpoint(resource)] as const;
export function useSharing(resource: ShareResource) {
  return useQuery({ queryKey: sharingKey(resource), queryFn: () => requestSharing(resource), staleTime: 0, gcTime: 0, refetchOnWindowFocus: false, refetchOnReconnect: false });
}
export function useSharedLibrary(token: string, folder: string | null, offset: number) {
  const params = new URLSearchParams({ offset: String(offset) });
  if (folder) params.set("folder", folder);
  return useQuery({
    queryKey: ["shared-library", token, folder, offset],
    queryFn: () => apiFetch<SharedLibraryPage>(`/api/cut-shared/library/${encodeURIComponent(token)}?${params}`, { cache: "no-store" }),
    retry: false,
    staleTime: 0,
    gcTime: 0,
  });
}
