export type ArtifactLifecycle = "retained" | "derived" | "scratch";

/** Derived playback files can be rebuilt from retained project media. */
export function artifactLifecycle(kind: string): ArtifactLifecycle {
  if (kind === "preview" || kind === "card" || kind === "hls") return "derived";
  if (kind === "overlay") return "scratch";
  return "retained";
}

export function artifactUsageBytes(bytes: bigint, complete: boolean, quotaExempt: boolean): bigint {
  return complete && !quotaExempt ? bytes : BigInt(0);
}
