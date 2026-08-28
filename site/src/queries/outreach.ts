"use client";

import {
  keepPreviousData,
  useMutation,
  useMutationState,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";

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

export const outreachSearchQueryKey = (q: string, status?: OutreachStatus) =>
  ["outreach", "search", q, status ?? "all"] as const;

// Super-user only: the rows matching a search, across every status or pinned
// to one, with per-status match counts. Matching runs in the database, so a
// hit past any list's page cap is still found. The previous result stays on
// screen while the next needle loads, so the badges never blink to zero.
export function useOutreachSearch(q: string, status?: OutreachStatus) {
  return useQuery({
    enabled: q !== "",
    placeholderData: keepPreviousData,
    queryFn: () =>
      apiFetch<{ counts: Record<OutreachStatus, number>; rows: OutreachRow[] }>(
        `/api/marketing/outreach?q=${encodeURIComponent(q)}${
          status ? `&status=${status}` : ""
        }`,
      ),
    queryKey: outreachSearchQueryKey(q, status),
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
  | {
      action: "send";
      outreachId: string;
      subject: string;
      body: string;
      unsubscribeLink: boolean;
      trackReplies: boolean;
    }
  | { action: "ignore" | "unignore" | "replied"; outreachId: string };

const outreachActionKey = ["outreach", "action"] as const;

// Any action moves a row between lists, so every list is invalidated. Actions
// run one per row and in parallel: the key lets the list ask which rows are in
// flight instead of freezing on any one of them.
export function useOutreachAction() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: OutreachAction) =>
      apiFetch<{ row: OutreachRow }>("/api/marketing/outreach", {
        body: JSON.stringify(input),
        method: "POST",
      }),
    mutationKey: outreachActionKey,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["outreach"] }),
  });
}

// The rows with an action still running.
export function useBusyOutreachIds(): Set<string> {
  const running = useMutationState({
    filters: { mutationKey: outreachActionKey, status: "pending" },
    select: (mutation) =>
      (mutation.state.variables as OutreachAction | undefined)?.outreachId,
  });
  return new Set(running.filter((id): id is string => typeof id === "string"));
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
