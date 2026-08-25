"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import type { OutreachStatus } from "@/lib/marketing/campaigns";
import { apiFetch } from "@/queries/apiClient";
import type { AsyncJobStatus } from "@/queries/jobs";

export type OutreachRow = {
  id: string;
  userId: string;
  name: string;
  email: string;
  status: OutreachStatus;
  // USD strings, as the credits API returns them everywhere else.
  spent: string;
  balance: string;
  lastActiveAt: string | null;
  ranOutAt: string | null;
  signedUpAt: string;
  sentCount: number;
  firstSentAt: string | null;
  lastSentAt: string | null;
  repliedAt: string | null;
};

export const outreachQueryKey = (status: OutreachStatus) =>
  ["outreach", status] as const;

// Super-user only: one page of the outreach list for a status.
export function useOutreach(status: OutreachStatus) {
  return useQuery({
    queryFn: () =>
      apiFetch<{ rows: OutreachRow[] }>(`/api/marketing/outreach?status=${status}`),
    queryKey: outreachQueryKey(status),
  });
}

export const outreachCountsQueryKey = ["outreach", "counts"] as const;

// How many rows every status holds. One key for all four, so switching lists
// never blanks the totals.
export function useOutreachCounts() {
  return useQuery({
    queryFn: () =>
      apiFetch<{ counts: Record<OutreachStatus, number> }>(
        "/api/marketing/outreach/counts",
      ),
    queryKey: outreachCountsQueryKey,
  });
}

type OutreachAction =
  | { action: "send"; outreachId: string; subject: string; body: string }
  | { action: "ignore" | "unignore" | "replied"; outreachId: string };

// Any action moves a row between lists, so every list is invalidated.
export function useOutreachAction() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: OutreachAction) =>
      apiFetch<{ row: OutreachRow }>("/api/marketing/outreach", {
        body: JSON.stringify(input),
        method: "POST",
      }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["outreach"] }),
  });
}

// Super-user only: roll credit usage into the list now and follow the job to
// completion, then refetch so the list updates in place.
export function useRunOutreachScan() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async () => {
      const { jobId } = await apiFetch<{ jobId: string }>("/api/jobs", {
        body: JSON.stringify({ kind: "outreach-scan", payload: {} }),
        method: "POST",
      });
      for (;;) {
        await new Promise((resolve) => setTimeout(resolve, 2000));
        const job = await apiFetch<AsyncJobStatus>(`/api/jobs/${jobId}`);
        if (job.state === "done") return job;
        if (job.state === "error") throw new Error(job.error ?? "The scan failed.");
      }
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["outreach"] }),
  });
}
