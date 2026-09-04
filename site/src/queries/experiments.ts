"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import type { ExperimentSummary, HoldoutRow } from "@/lib/config/experimentList";
import type { ExperimentInput, ExperimentStatus } from "@/lib/config/experiment";
import { apiFetch } from "@/queries/apiClient";

export type { ExperimentSummary, HoldoutRow };

export const experimentsQueryKey = ["su", "experiments"] as const;

type Body = { experiments: ExperimentSummary[] };

// Super-user only: every experiment with per-variant counts.
export function useExperiments() {
  return useQuery({
    queryFn: () => apiFetch<Body>("/api/experiments"),
    queryKey: experimentsQueryKey,
  });
}

export function useCreateExperiment() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: ExperimentInput) =>
      apiFetch<Body>("/api/experiments", { body: JSON.stringify(input), method: "POST" }),
    onSuccess: (body) => queryClient.setQueryData(experimentsQueryKey, body),
  });
}

export function useUpdateExperiment() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...input }: ExperimentInput & { id: string }) =>
      apiFetch<Body>(`/api/experiments/${encodeURIComponent(id)}`, {
        body: JSON.stringify(input),
        method: "PUT",
      }),
    onSuccess: (body) => queryClient.setQueryData(experimentsQueryKey, body),
  });
}

export function useSetExperimentStatus() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, status }: { id: string; status: ExperimentStatus }) =>
      apiFetch<Body>(`/api/experiments/${encodeURIComponent(id)}`, {
        body: JSON.stringify({ status }),
        method: "PATCH",
      }),
    onSuccess: (body) => queryClient.setQueryData(experimentsQueryKey, body),
  });
}

export function useDeleteExperiment() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      apiFetch<Body>(`/api/experiments/${encodeURIComponent(id)}`, { method: "DELETE" }),
    onSuccess: (body) => queryClient.setQueryData(experimentsQueryKey, body),
  });
}

// A row written by hand: the account reads this variant (null holds it out).
export function useSetAssignment() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, email, variant }: { id: string; email: string; variant: string | null }) =>
      apiFetch<Body>(`/api/experiments/${encodeURIComponent(id)}/assignments`, {
        body: JSON.stringify({ email, variant }),
        method: "PUT",
      }),
    onSuccess: (body) => queryClient.setQueryData(experimentsQueryKey, body),
  });
}

export function useRemoveAssignment() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, userId }: { id: string; userId: string }) =>
      apiFetch<Body>(`/api/experiments/${encodeURIComponent(id)}/assignments`, {
        body: JSON.stringify({ userId }),
        method: "DELETE",
      }),
    onSuccess: (body) => queryClient.setQueryData(experimentsQueryKey, body),
  });
}

// Runs the results job for one experiment and follows it to completion, then
// refetches the list so the new read shows.
export function useComputeResults() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (experimentId: string) => {
      const { jobId } = await apiFetch<{ jobId: string }>("/api/jobs", {
        body: JSON.stringify({ kind: "experiment-results", payload: { experimentId } }),
        method: "POST",
      });
      for (;;) {
        await new Promise((resolve) => setTimeout(resolve, 2000));
        const job = await apiFetch<{ state: string; error?: string }>(`/api/jobs/${jobId}`);
        if (job.state === "done") return job;
        if (job.state === "error") throw new Error(job.error ?? "The run failed.");
      }
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: experimentsQueryKey }),
  });
}

export const holdoutQueryKey = ["su", "holdout"] as const;

type HoldoutBody = { holdout: HoldoutRow[] };

export function useHoldout() {
  return useQuery({
    queryFn: () => apiFetch<HoldoutBody>("/api/experiments/holdout"),
    queryKey: holdoutQueryKey,
  });
}

export function useAddHoldout() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: { email: string; note: string | null }) =>
      apiFetch<HoldoutBody>("/api/experiments/holdout", { body: JSON.stringify(input), method: "POST" }),
    onSuccess: (body) => queryClient.setQueryData(holdoutQueryKey, body),
  });
}

export function useRemoveHoldout() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (userId: string) =>
      apiFetch<HoldoutBody>("/api/experiments/holdout", { body: JSON.stringify({ userId }), method: "DELETE" }),
    onSuccess: (body) => queryClient.setQueryData(holdoutQueryKey, body),
  });
}
