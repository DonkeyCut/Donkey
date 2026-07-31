"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { apiFetch } from "@/queries/apiClient";

export const emailPreferencesQueryKey = ["account-email-preferences"] as const;

export type EmailPreferences = {
  marketingEmails: boolean;
};

export function useEmailPreferences() {
  return useQuery({
    queryFn: () =>
      apiFetch<EmailPreferences>("/api/account/email-preferences"),
    queryKey: emailPreferencesQueryKey,
  });
}

export function useSetEmailPreferences() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (update: EmailPreferences) =>
      apiFetch<EmailPreferences>("/api/account/email-preferences", {
        body: JSON.stringify(update),
        method: "PUT",
      }),
    onSuccess: (prefs) => {
      queryClient.setQueryData(emailPreferencesQueryKey, prefs);
    },
  });
}
