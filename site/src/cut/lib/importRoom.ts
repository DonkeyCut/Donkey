// The size check before a drop on a cloud project uploads anything. The drop
// still lands on screen and in this browser's store; when the account's cloud
// storage can't take it, the storage wall goes up once, with the drop's own
// numbers, before the first upload is refused. Every refusal that follows
// from the same drop stays quiet (storageQuota.ts).
import { getBackend } from "./backend";
import { fetchCloudUsage } from "./backend/cloud";
import { emitImportWall, startImportWall } from "./storageQuota";
import { useEditor } from "./store";

/** Starts a drop's one storage wall, and raises it now when the drop won't
 * fit. Never holds the drop: the read runs beside its imports. */
export function checkImportRoom(files: File[]): void {
  if (getBackend().kind !== "cloud" || files.length === 0) {
    return;
  }
  startImportWall();

  // Uploads still on their way count too: the drop lands after them. Read
  // now, before this drop's own files join them.
  const pending = useEditor
    .getState()
    .assets.filter((a) => a.upload)
    .reduce((sum, a) => sum + (a.sizeBytes ?? 0), 0);
  void fitsCloud(files, pending).then((detail) => {
    if (detail) {
      emitImportWall({ source: "import", ...detail });
    }
  });
}

/** The wall's numbers when the drop won't fit, or null when it will (or the
 * usage can't be read, where the uploads' own refusal raises the wall). */
async function fitsCloud(
  files: File[],
  pending: number
): Promise<{ bytes: number; quotaBytes: number; needBytes: number } | null> {
  const usage = await fetchCloudUsage().catch(() => null);
  if (!usage) {
    return null;
  }
  const quotaBytes = usage.quotaBytes;
  if (quotaBytes === null) {
    return null;
  }

  const needBytes = files.reduce((sum, f) => sum + f.size, 0);
  const bytes = usage.bytes + pending;
  return bytes + needBytes > quotaBytes ? { bytes, quotaBytes, needBytes } : null;
}
