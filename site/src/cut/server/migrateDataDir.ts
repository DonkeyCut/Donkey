import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * One-time launch migration (shipped 2026-08-04): the Cut data root moved from
 * ~/Library/Application Support/DonkeyCut to ~/Movies/DonkeyCut. The engine
 * runs this once at startup, before any route can touch the data root: it
 * moves the old folder into place and removes the Application Support/Donkey
 * folder left behind by builds from before the video-editor pivot.
 *
 * TODO: delete this module and its serve.ts call after 2026-10-03 — by then
 * auto-updating installs have migrated.
 */
export function migrateCutDataDir(): void {
  if (process.env.DONKEY_CUT_DATA_DIR || !process.env.DONKEY_CUT_ENGINE) return;
  const appSupport = path.join(os.homedir(), "Library", "Application Support");
  const oldRoot = path.join(appSupport, "DonkeyCut");
  const newRoot = path.join(os.homedir(), "Movies", "DonkeyCut");
  try {
    if (fs.existsSync(oldRoot) && !fs.existsSync(newRoot)) {
      // Same volume (both under the home directory), so this is an atomic
      // rename regardless of how much media the folder holds.
      fs.renameSync(oldRoot, newRoot);
      console.log(`migrated cut data ${oldRoot} -> ${newRoot}`);
    }
    // Once the Movies root exists, anything still at the old path is stale;
    // clear it so no data lingers in Application Support.
    if (fs.existsSync(newRoot)) {
      fs.rmSync(oldRoot, { recursive: true, force: true });
    }
  } catch (err) {
    console.error(
      `cut data migration failed, keeping ${oldRoot}: ${err instanceof Error ? err.message : String(err)}`
    );
  }
  try {
    fs.rmSync(path.join(appSupport, "Donkey"), { recursive: true, force: true });
  } catch {
    // Leftover cleanup only; the engine runs fine with the folder still there.
  }
}
