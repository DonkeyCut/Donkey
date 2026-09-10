"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { Audience } from "@donkeycut/abexp";

import type {
  PromotionInput,
  PromotionSender,
  PromotionSummary,
  SegmentCount,
} from "@/lib/marketing/promotionInput";
import { apiFetch } from "@/queries/apiClient";

export type { PromotionSummary };

export const promotionsQueryKey = ["su", "promotions"] as const;

type Body = { promotions: PromotionSummary[]; senders: Record<PromotionSender, string> };

// Super-user only: every promotion with how far its send got, and the address
// each sender stands for. Polls while a send is running.
export function usePromotions() {
  return useQuery({
    queryFn: () => apiFetch<Body>("/api/su/promotions"),
    queryKey: promotionsQueryKey,
    refetchInterval: (query) =>
      query.state.data?.promotions.some((p) => p.status === "sending") ? 3000 : false,
  });
}

// A new draft, or an edit of one. Answers with the saved id.
export function useSavePromotion() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...input }: PromotionInput & { id: string | null }) =>
      apiFetch<{ id: string; promotions: PromotionSummary[] }>(
        id ? `/api/su/promotions/${encodeURIComponent(id)}` : "/api/su/promotions",
        { body: JSON.stringify(input), method: id ? "PUT" : "POST" },
      ),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: promotionsQueryKey }),
  });
}

export function useDeletePromotion() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      apiFetch<{ promotions: PromotionSummary[] }>(`/api/su/promotions/${encodeURIComponent(id)}`, {
        method: "DELETE",
      }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: promotionsQueryKey }),
  });
}

// Starts the send; the list's polling follows it to sent.
export function useSendPromotion() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      apiFetch<{ recipients: number }>(
        `/api/su/promotions/${encodeURIComponent(id)}/send`,
        { method: "POST" },
      ),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: promotionsQueryKey }),
  });
}

export function useCancelPromotion() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      apiFetch<{ promotions: PromotionSummary[] }>(
        `/api/su/promotions/${encodeURIComponent(id)}/cancel`,
        { method: "POST" },
      ),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: promotionsQueryKey }),
  });
}

// Mails the saved copy to the operator.
export function useTestPromotion() {
  return useMutation({
    mutationFn: (id: string) =>
      apiFetch<{ sentTo: string }>(`/api/su/promotions/${encodeURIComponent(id)}/test`, {
        method: "POST",
      }),
  });
}

// How many accounts a segment reaches right now.
export function useCountSegment() {
  return useMutation({
    mutationFn: (segment: { audience: Audience; excludePromotionIds: string[] }) =>
      apiFetch<SegmentCount>("/api/su/promotions/segment", {
        body: JSON.stringify(segment),
        method: "POST",
      }),
  });
}
