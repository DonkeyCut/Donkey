export type StorageQuotaDetail = {
  bytes?: number;
  quotaBytes?: number;
  /** What raised the wall: a rejected write, a render refused its space, or
   * the top bar's pill. */
  source: "quota-413" | "render" | "pill";
  grace?: { deadline: string; overBytes: number };
};

const listeners = new Set<(detail: StorageQuotaDetail) => void>();

// A rejected upload rejects once per file, and every file in the batch is over
// the same limit. The first one raises the wall; the rest are the same event,
// so they stay quiet until the user has answered it.
let walled = false;

/** True when the wall actually went up for someone. A caller that only wants
 * to tell the user once has to know whether this landed: with the dialog not
 * yet mounted, or a wall already standing, nobody was told. */
export function emitStorageQuota(detail: StorageQuotaDetail): boolean {
  if (walled || listeners.size === 0) return false;
  walled = true;
  for (const listener of listeners) listener(detail);
  return true;
}

/** Open the dialog from a deliberate click, past any standing wall. */
export function openStorageUpgrade(detail: StorageQuotaDetail): void {
  walled = false;
  emitStorageQuota(detail);
}

/** Called when the dialog closes: the next rejection is news again. */
export function clearStorageQuotaWall(): void {
  walled = false;
}

export function onStorageQuota(handler: (detail: StorageQuotaDetail) => void): () => void {
  listeners.add(handler);
  return () => {
    listeners.delete(handler);
    if (listeners.size === 0) walled = false;
  };
}
