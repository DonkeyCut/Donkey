"use client";

import { useQuery } from "@tanstack/react-query";

import type { AnalyticsRollup } from "@/lib/analytics/schema";
import { apiFetch } from "@/queries/apiClient";

export const analyticsRollupQueryKey = ["analytics", "rollup"] as const;

// Super-user only: the nightly job's consolidated rollup. Stale until the
// next run by design.
export function useAnalyticsRollup() {
  return useQuery({
    queryFn: () => apiFetch<AnalyticsRollup>("/api/analytics/rollup"),
    queryKey: analyticsRollupQueryKey,
  });
}
