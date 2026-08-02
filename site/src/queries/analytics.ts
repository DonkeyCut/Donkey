"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import type { AnalyticsRollup } from "@/lib/analytics/schema";
import { apiFetch } from "@/queries/apiClient";
import type { AsyncJobStatus } from "@/queries/jobs";

export const analyticsRollupQueryKey = ["analytics", "rollup"] as const;

// Super-user only: the nightly job's consolidated rollup. Stale until the
// next run by design.
export function useAnalyticsRollup() {
  return useQuery({
    queryFn: () => apiFetch<AnalyticsRollup>("/api/analytics/rollup"),
    queryKey: analyticsRollupQueryKey,
  });
}

// Super-user only: run the analytics-daily job now and follow it to
// completion, then refetch the rollup so the dashboard updates in place.
export function useRunAnalytics() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async () => {
      const { jobId } = await apiFetch<{ jobId: string }>("/api/jobs", {
        body: JSON.stringify({ kind: "analytics-daily", payload: {} }),
        method: "POST",
      });
      for (;;) {
        await new Promise((resolve) => setTimeout(resolve, 2000));
        const job = await apiFetch<AsyncJobStatus>(`/api/jobs/${jobId}`);
        if (job.state === "done") return job;
        if (job.state === "error") throw new Error(job.error ?? "The run failed.");
      }
    },
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: analyticsRollupQueryKey }),
  });
}
