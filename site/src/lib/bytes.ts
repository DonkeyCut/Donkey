/** A byte count in the units a person reads at a glance: KB under a megabyte,
 * MB up to a gigabyte, GB above it. One implementation, so the cloud shelf, the
 * Outreach list, and an outreach email all say the same number. */
export function formatBytes(n: number): string {
  if (n <= 0) return "0 MB";
  const mb = n / (1024 * 1024);
  if (mb < 1) return `${Math.max(1, Math.round(n / 1024))} KB`;
  return mb >= 1024 ? `${(mb / 1024).toFixed(1)} GB` : `${mb < 10 ? mb.toFixed(1) : Math.round(mb)} MB`;
}
