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

// A body that is not this shape is a failed read. Parsed here, at the wire,
// so the query holds the error: the gate this runs from wraps the whole app,
// and a payload thrown into that tree takes the editor down with it.
function parseAccountConfig(raw: unknown): AccountConfig {
  const body = raw as Partial<AccountConfig> | null;
  if (!body?.settings || !body.experiments || !Array.isArray(body.exposed)) {
    throw new Error("/api/account/config answered without settings, experiments and exposed");
  }
  return { settings: body.settings, experiments: body.experiments, exposed: body.exposed };
}

// Fetched once per page load from the session gate. It never refetches on
// focus: a variant switching under someone mid-session is the one thing an
// experiment must not do.
export function useAccountConfig({ enabled }: { enabled: boolean }) {
  return useQuery({
    enabled,
    queryFn: async () => parseAccountConfig(await apiFetch<unknown>("/api/account/config")),
    queryKey: accountConfigQueryKey,
    refetchOnWindowFocus: false,
    retry: false,
    staleTime: Infinity,
  });
}
