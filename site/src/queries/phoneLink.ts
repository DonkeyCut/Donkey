"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { apiFetch } from "@/cut/lib/api";

// The phone link lives on this Mac's engine, so these go through the engine
// transport rather than the site's own API. Everything here is off when the
// app is not running: there is no hosted twin of a Bonjour listener.

export const phoneLinkQueryKey = ["cut", "phone-link"] as const;

export type PhoneDevice = {
  id: string;
  name: string;
  pairedAt: number;
  lastSeenAt: number;
};

export type PhonePairingWindow = {
  code: string;
  expiresAt: number;
};

export type PhoneLinkStatus = {
  devices: PhoneDevice[];
  pairing: PhonePairingWindow | null;
  /** How the last window ended, once one is no longer open. */
  closed: "paired" | "refused" | null;
};

async function engineJson<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await apiFetch(path, init);
  if (!response.ok) throw new Error(`phone link ${response.status}`);
  return (await response.json()) as T;
}

/** The paired phones and the open pairing code. Polls while a code is up, so
 * the card can close itself the moment a phone answers. */
export function usePhoneLink(enabled: boolean) {
  return useQuery<PhoneLinkStatus>({
    enabled,
    queryKey: phoneLinkQueryKey,
    queryFn: () => engineJson<PhoneLinkStatus>("/api/cut/phone"),
    refetchInterval: (query) => (query.state.data?.pairing ? 2000 : false),
  });
}

export function useStartPhonePairing() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => engineJson<PhonePairingWindow>("/api/cut/phone/pair", { method: "POST" }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: phoneLinkQueryKey }),
  });
}

export function useCancelPhonePairing() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => engineJson<{ ok: true }>("/api/cut/phone/pair", { method: "DELETE" }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: phoneLinkQueryKey }),
  });
}

export function useUnpairPhone() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      engineJson<{ ok: true }>(`/api/cut/phone/devices/${encodeURIComponent(id)}`, {
        method: "DELETE",
      }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: phoneLinkQueryKey }),
  });
}
