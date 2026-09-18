"use client";

import {
  infiniteQueryOptions,
  queryOptions,
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { useEffect } from "react";

import type { AnalyticsUsersPage, UserSort } from "@/lib/analytics/rank";
import type { AnalyticsSummary } from "@/lib/analytics/summarize";
import { apiFetch } from "@/queries/apiClient";
import type { AsyncJobStatus } from "@/queries/jobs";

export const analyticsQueryKey = ["analytics"] as const;
export const analyticsSummaryQueryKey = [...analyticsQueryKey, "summary"] as const;

// Super-user only: the nightly job's numbers, without the account table. It
// changes once a night, and a manual run invalidates it, so a copy in memory
// stays good for the session.
const analyticsSummaryQuery = queryOptions({
  queryFn: () => apiFetch<AnalyticsSummary>("/api/analytics/summary"),
  queryKey: analyticsSummaryQueryKey,
  staleTime: 60 * 60_000,
});

export function useAnalyticsSummary() {
  return useQuery(analyticsSummaryQuery);
}

// Pulls the summary as soon as the super-user shell mounts, so the Product tab
// paints from memory when it opens.
export function useWarmAnalyticsSummary() {
  const queryClient = useQueryClient();
  useEffect(() => {
    void queryClient.prefetchQuery(analyticsSummaryQuery);
  }, [queryClient]);
}

// Accounts in rank order, a page at a time: ask for the first page, then
// follow the cursor the server hands back — the phone reads the same endpoint
// the same way, and the page size stays the server's to set. Ranks hold only
// within one rollup, so the rollup's stamp is part of the key: a fresh rollup
// is a fresh list rather than pages from two different orders stitched
// together.
function analyticsUsersQuery(sort: UserSort, generatedAt: string) {
  return infiniteQueryOptions({
    getNextPageParam: (page: AnalyticsUsersPage) => page.nextCursor,
    initialPageParam: 0,
    queryFn: ({ pageParam }) =>
      apiFetch<AnalyticsUsersPage>(`/api/analytics/users?sort=${sort}&cursor=${pageParam}`),
    queryKey: [...analyticsQueryKey, "users", generatedAt, sort] as const,
    staleTime: 60 * 60_000,
  });
}

export function useAnalyticsUsers(sort: UserSort, generatedAt: string) {
  return useInfiniteQuery(analyticsUsersQuery(sort, generatedAt));
}

/** One account's row, for a panel that opens on a single person. */
export function useAnalyticsUser(userId: string) {
  return useQuery({
    queryFn: async () => {
      const page = await apiFetch<AnalyticsUsersPage>(
        `/api/analytics/users?id=${encodeURIComponent(userId)}`,
      );
      return page.users[0] ?? null;
    },
    queryKey: [...analyticsQueryKey, "user", userId] as const,
    staleTime: 60 * 60_000,
  });
}

// Super-user only: run the analytics-daily job now and follow it to
// completion, then refetch what the dashboard shows.
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
    onSuccess: () => queryClient.invalidateQueries({ queryKey: analyticsQueryKey }),
  });
}
