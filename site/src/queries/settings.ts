"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import type { SettingKey } from "@/lib/config/registry";
import { apiFetch } from "@/queries/apiClient";

export type SettingRow = {
  key: SettingKey;
  title: string;
  description: string;
  public: boolean;
  default: unknown;
  value: unknown;
  overridden: boolean;
  invalid: boolean;
  updatedAt: string | null;
  schema: Record<string, unknown>;
};

export const settingsQueryKey = ["su", "settings"] as const;

type Body = { settings: SettingRow[] };

// Super-user only: every registered setting with its current override.
export function useSettings() {
  return useQuery({
    queryFn: () => apiFetch<Body>("/api/settings"),
    queryKey: settingsQueryKey,
  });
}

export function useSaveSetting() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: { key: SettingKey; value: unknown }) =>
      apiFetch<Body>("/api/settings", { body: JSON.stringify(input), method: "PUT" }),
    onSuccess: (body) => queryClient.setQueryData(settingsQueryKey, body),
  });
}

export function useResetSetting() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (key: SettingKey) =>
      apiFetch<Body>(`/api/settings?key=${encodeURIComponent(key)}`, { method: "DELETE" }),
    onSuccess: (body) => queryClient.setQueryData(settingsQueryKey, body),
  });
}
