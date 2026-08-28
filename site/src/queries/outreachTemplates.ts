"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { apiFetch } from "@/queries/apiClient";

export type SavedTemplate = {
  id: string;
  name: string;
  subject: string;
  body: string;
  unsubscribeLink: boolean;
  trackReplies: boolean;
  updatedAt: string;
};

export const outreachTemplatesQueryKey = ["outreach", "templates"] as const;

// Super-user only: every saved template, by name.
export function useOutreachTemplates() {
  return useQuery({
    queryFn: () =>
      apiFetch<{ templates: SavedTemplate[] }>("/api/marketing/templates"),
    queryKey: outreachTemplatesQueryKey,
  });
}

// Saving under an existing name rewrites that template.
export function useSaveOutreachTemplate() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: {
      name: string;
      subject: string;
      body: string;
      unsubscribeLink: boolean;
      trackReplies: boolean;
    }) =>
      apiFetch<{ template: SavedTemplate }>("/api/marketing/templates", {
        body: JSON.stringify(input),
        method: "POST",
      }),
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: outreachTemplatesQueryKey }),
  });
}

export function useDeleteOutreachTemplate() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      apiFetch<{ ok: true }>(
        `/api/marketing/templates?id=${encodeURIComponent(id)}`,
        { method: "DELETE" },
      ),
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: outreachTemplatesQueryKey }),
  });
}
