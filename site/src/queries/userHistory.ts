"use client";

import { useQuery } from "@tanstack/react-query";

import type { UserHistory } from "@/lib/marketing/userHistory";
import { apiFetch } from "@/queries/apiClient";

export type { UserHistory, UserHistoryEmail, UserHistoryGrant, UserHistoryOffer } from "@/lib/marketing/userHistory";

// Super-user only: one account's offers, grants, mail and storage. Read when
// the operator opens the history, and held for the session — a note sent
// from the same dialog invalidates it.
export function useUserHistory(userId: string | null) {
  return useQuery({
    enabled: userId !== null,
    queryFn: () => apiFetch<UserHistory>(`/api/su/users/${encodeURIComponent(userId!)}/history`),
    queryKey: ["su", "users", userId, "history"] as const,
    staleTime: 5 * 60_000,
  });
}
