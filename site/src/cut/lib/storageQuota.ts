export type StorageQuotaDetail = {
  bytes?: number;
  quotaBytes?: number;
  source: "quota-413" | "pill";
  grace?: { deadline: string; overBytes: number };
};

const listeners = new Set<(detail: StorageQuotaDetail) => void>();

// A rejected upload rejects once per file, and every file in the batch is over
// the same limit. The first one raises the wall; the rest are the same event,
// so they stay quiet until the user has answered it.
let walled = false;

export function emitStorageQuota(detail: StorageQuotaDetail): void {
  if (walled || listeners.size === 0) return;
  walled = true;
  for (const listener of listeners) listener(detail);
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
