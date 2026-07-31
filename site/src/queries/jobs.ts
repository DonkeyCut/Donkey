"use client";

import { useMutation, useQuery } from "@tanstack/react-query";

import { apiFetch } from "@/queries/apiClient";

export type AsyncJobStatus = {
  kind: string;
  state: "queued" | "running" | "done" | "error";
  result?: Record<string, unknown>;
  error?: string;
};

export type AsyncJobListItem = {
  id: string;
  kind: string;
  state: AsyncJobStatus["state"];
  payload: unknown;
  result?: Record<string, unknown>;
  error?: string;
  createdAt: string;
};

export const jobStatusQueryKey = (jobId: string) => ["jobs", jobId] as const;
export const recentJobsQueryKey = ["jobs", "recent"] as const;

// Super-user only: start a background job on the hosted API. The caller keeps
// the returned jobId and polls it with useJobStatus.
export function useStartJob() {
  return useMutation({
    mutationFn: (input: { kind: string; payload: unknown }) =>
      apiFetch<{ jobId: string }>("/api/jobs", {
        body: JSON.stringify(input),
        method: "POST",
      }),
  });
}

// Super-user only: the last few jobs, newest first. Polls while any listed
// job is still in flight so states settle on screen without a refresh.
export function useRecentJobs(enabled: boolean) {
  return useQuery({
    enabled,
    queryFn: () => apiFetch<{ jobs: AsyncJobListItem[] }>("/api/jobs"),
    queryKey: recentJobsQueryKey,
    refetchInterval: (query) =>
      query.state.data?.jobs.some(
        (job) => job.state === "queued" || job.state === "running",
      )
        ? 2000
        : false,
  });
}

// Poll one job every couple of seconds until it settles.
export function useJobStatus(jobId: string | null) {
  return useQuery({
    enabled: jobId !== null,
    queryFn: () => apiFetch<AsyncJobStatus>(`/api/jobs/${jobId}`),
    queryKey: jobStatusQueryKey(jobId ?? "none"),
    refetchInterval: (query) => {
      const state = query.state.data?.state;
      return state === "done" || state === "error" ? false : 2000;
    },
  });
}
