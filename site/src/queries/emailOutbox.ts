"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import type { EmailKindId } from "@/lib/email/kindIds";
import type { OutboxOverview } from "@/lib/email/outbox";
import { apiFetch } from "@/queries/apiClient";

export type { OutboxCampaign, OutboxItem, OutboxKindRow, OutboxOverview } from "@/lib/email/outbox";

export const emailOutboxQueryKey = ["su", "email", "outbox"] as const;

// Super-user only: the outbox and the cycle's budget. Polls while anything is
// queued so sends settle on screen without a refresh.
export function useEmailOutbox() {
  return useQuery({
    queryFn: () => apiFetch<OutboxOverview>("/api/su/email"),
    queryKey: emailOutboxQueryKey,
    refetchInterval: (query) => (query.state.data?.kinds.some((k) => k.queued > 0) ? 5000 : 60000),
  });
}

// Drain one kind now, or put one failed row back in the queue; the response
// is the refreshed overview.
export function useOutboxAction() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: { action: "drain"; kind: EmailKindId } | { action: "retry"; id: string }) =>
      apiFetch<OutboxOverview>("/api/su/email", { body: JSON.stringify(body), method: "POST" }),
    onSuccess: (data) => queryClient.setQueryData(emailOutboxQueryKey, data),
  });
}
