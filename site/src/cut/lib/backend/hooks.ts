// React bindings for the backend seam, kept out of ./index so the engine
// binary (which compiles lib/types.ts → ./index) never bundles React.
import { useQuery } from "@tanstack/react-query";
import { useSyncExternalStore } from "react";

import { cutMode, getBackend, subscribeCutMode } from "./index";
import type { CutCaps, CutMode } from "./types";

export function useCutMode(): CutMode {
  return useSyncExternalStore(subscribeCutMode, cutMode, () => "local" as const);
}

export function useCutCaps(): CutCaps {
  useCutMode();
  return getBackend().caps;
}

export const cloudUsageQueryKey = ["cut", "cloud-usage"] as const;

export type CloudUsage = {
  bytes: number;
  /** null = unlimited. */
  quotaBytes: number | null;
  /** Present when the account's Pro ended and it holds more than the free cap:
   * the sweep reclaims storage after `deadline` unless `overBytes` is freed. */
  grace?: { deadline: string; overBytes: number };
};

/** The account's cloud storage usage — cloud-only by construction, so it hits
 * the hosted route directly on the session cookie. `poll` is for the editor's
 * live meter; readers that only need the number once should leave it off. */
export function useCloudUsage(enabled: boolean, opts?: { poll?: boolean }) {
  return useQuery<CloudUsage>({
    enabled,
    queryKey: cloudUsageQueryKey,
    queryFn: async () => {
      const res = await fetch("/api/cut-cloud/usage");
      if (!res.ok) throw new Error(`usage ${res.status}`);
      return (await res.json()) as CloudUsage;
    },
    ...(opts?.poll ? { refetchInterval: 60_000 } : {}),
  });
}
