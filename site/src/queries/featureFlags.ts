"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { apiFetch } from "@/queries/apiClient";

export const featureFlagsQueryKey = ["account-feature-flags"] as const;

export type AccountFlag = {
  id: string;
  title: string;
  description: string;
  enabled: boolean;
};

export function useAccountFlags() {
  return useQuery({
    queryFn: async () => {
      const body = await apiFetch<{ flags: AccountFlag[] }>(
        "/api/account/feature-flags",
      );
      return body.flags;
    },
    queryKey: featureFlagsQueryKey,
  });
}

// The switch shows the new state while the account write is in flight and puts
// itself back if the write fails, so a flag can't read as on when it isn't.
export function useSetAccountFlag() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (variables: { flag: string; enabled: boolean }) =>
      apiFetch<{ ok: true }>("/api/account/feature-flags", {
        body: JSON.stringify(variables),
        method: "PUT",
      }),
    onMutate: ({ flag, enabled }) => {
      const previous = queryClient.getQueryData<AccountFlag[]>(featureFlagsQueryKey);
      queryClient.setQueryData<AccountFlag[]>(featureFlagsQueryKey, (flags) =>
        flags?.map((f) => (f.id === flag ? { ...f, enabled } : f)),
      );
      return { previous };
    },
    onError: (_error, _variables, context) => {
      queryClient.setQueryData(featureFlagsQueryKey, context?.previous);
    },
  });
}
