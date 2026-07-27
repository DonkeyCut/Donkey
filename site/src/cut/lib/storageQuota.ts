// The storage-quota wall: one contract shared by the code that hits the limit
// (the cloud transport's 413 handler) and the dialog that offers the upgrade.
// It lives in lib so the React-free transport can raise it.

export type StorageQuotaDetail = {
  bytes?: number;
  quotaBytes?: number;
  source: "quota-413" | "pill";
  grace?: { deadline: string; overBytes: number };
};

const EVENT = "cut-storage-quota";

// A rejected upload rejects once per file, and every file in the batch is over
// the same limit. The first one raises the wall; the rest are the same event,
// so they stay quiet until the user has answered it.
let walled = false;

export function emitStorageQuota(detail: StorageQuotaDetail): void {
  if (typeof window === "undefined" || walled) return;
  walled = true;
  window.dispatchEvent(new CustomEvent(EVENT, { detail }));
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
  const listener = (e: Event) => handler((e as CustomEvent<StorageQuotaDetail>).detail);
  window.addEventListener(EVENT, listener);
  return () => window.removeEventListener(EVENT, listener);
}
