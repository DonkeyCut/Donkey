"use client";

import { useQuery } from "@tanstack/react-query";

import type { PublicSettings } from "@/lib/config/registry";
import { apiFetch } from "@/queries/apiClient";

export const accountConfigQueryKey = ["account", "config"] as const;

export type AccountConfig = {
  settings: PublicSettings;
  // experiment key → the variant this account holds.
  experiments: Record<string, string>;
  // Experiment keys this read exposed for the first time.
  exposed: string[];
};

// Fetched once per page load from the session gate. It never refetches on
// focus: a variant switching under someone mid-session is the one thing an
// experiment must not do.
export function useAccountConfig({ enabled }: { enabled: boolean }) {
  return useQuery({
    enabled,
    queryFn: () => apiFetch<AccountConfig>("/api/account/config"),
    queryKey: accountConfigQueryKey,
    refetchOnWindowFocus: false,
    retry: false,
    staleTime: Infinity,
  });
}
