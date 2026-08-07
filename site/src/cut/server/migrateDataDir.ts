import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { cutDataRoot } from "./dataDir";

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

/**
 * One-time launch migration (shipped 2026-08-07): local Cut data belongs to the
 * Mac user, so the per-account users/<id>/ layer is gone — projects/ and
 * library/ sit directly under the data root. This folds every account dir into
 * the root: project folders move over (a name collision gains a -2, -3, …
 * suffix), folder and library indexes merge, and library media files are
 * copied in with the same suffixing, their index entries re-pointed, before
 * the source dir is removed. The most recently used account merges first, so
 * its names stay unsuffixed. Both mounts run it before serving data routes.
 *
 * TODO: delete this function and its callers after 2026-10-06 — by then
 * auto-updating installs have migrated.
 */
export function flattenCutUsers(): void {
  const root = cutDataRoot();
  const usersDir = path.join(root, "users");
  if (!fs.existsSync(usersDir)) return;
  try {
    const accountDirs = fs
      .readdirSync(usersDir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => path.join(usersDir, e.name))
      .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
    for (const dir of accountDirs) {
      mergeProjects(path.join(dir, "projects"), path.join(root, "projects"));
      mergeLibrary(path.join(dir, "library"), path.join(root, "library"));
      removeIfEmpty(dir);
    }
    removeIfEmpty(usersDir);
    if (!fs.existsSync(usersDir)) console.log(`flattened cut user data into ${root}`);
  } catch (err) {
    console.error(
      `cut user-dir flatten failed, keeping ${usersDir}: ${err instanceof Error ? err.message : String(err)}`
    );
  }
}

/** A directory name not yet taken in `dest`: the name itself, else -2, -3, … */
function freeDirName(dest: string, name: string): string {
  if (!fs.existsSync(path.join(dest, name))) return name;
  for (let n = 2; ; n++) {
    const candidate = `${name}-${n}`;
    if (!fs.existsSync(path.join(dest, candidate))) return candidate;
  }
}

/** A file name not yet taken in `dest`, suffixing before the extension. */
function freeFileName(dest: string, name: string): string {
  if (!fs.existsSync(path.join(dest, name))) return name;
  const ext = path.extname(name);
  const stem = name.slice(0, name.length - ext.length);
  for (let n = 2; ; n++) {
    const candidate = `${stem}-${n}${ext}`;
    if (!fs.existsSync(path.join(dest, candidate))) return candidate;
  }
}

function readJson<T>(file: string): T | null {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as T;
  } catch {
    return null;
  }
}

/** Remove a directory that holds nothing (Finder's .DS_Store included). */
function removeIfEmpty(dir: string): void {
  if (!fs.existsSync(dir)) return;
  const entries = fs.readdirSync(dir);
  if (entries.length === 1 && entries[0] === ".DS_Store") {
    fs.rmSync(path.join(dir, ".DS_Store"), { force: true });
  }
  if (fs.readdirSync(dir).length === 0) fs.rmdirSync(dir);
}

interface FolderEntry {
  id: string;
}

function mergeProjects(src: string, dest: string): void {
  if (!fs.existsSync(src)) return;
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const from = path.join(src, entry.name);
    if (entry.isDirectory()) {
      fs.renameSync(from, path.join(dest, freeDirName(dest, entry.name)));
    } else if (entry.name === "folders.json") {
      const ours = readJson<{ folders?: FolderEntry[] }>(from)?.folders ?? [];
      const destFile = path.join(dest, "folders.json");
      const merged = readJson<{ folders?: FolderEntry[] }>(destFile)?.folders ?? [];
      const known = new Set(merged.map((f) => f.id));
      for (const f of ours) if (!known.has(f.id)) merged.push(f);
      fs.writeFileSync(destFile, JSON.stringify({ folders: merged }));
      fs.rmSync(from, { force: true });
    } else if (entry.name === "folders.json.bak" || entry.name === ".DS_Store") {
      fs.rmSync(from, { force: true });
    }
  }
  removeIfEmpty(src);
}

interface LibraryIndexFile {
  assets?: { fileName: string; folderId?: string | null }[];
  folders?: FolderEntry[];
  templates?: { media?: { fileName: string }[] }[];
}

function mergeLibrary(src: string, dest: string): void {
  if (!fs.existsSync(src)) return;
  if (!fs.existsSync(dest)) {
    fs.renameSync(src, dest);
    return;
  }
  // Read the account's index up front — library.json, then its .bak mirror.
  // An index file that exists but is unreadable in both copies aborts this
  // account's merge with everything left in place: merging the media without
  // it would strand every asset, and deleting it would destroy the one
  // recoverable record of the account's library.
  const srcIndexFile = path.join(src, "library.json");
  const srcIndex =
    readJson<LibraryIndexFile>(srcIndexFile) ?? readJson<LibraryIndexFile>(`${srcIndexFile}.bak`);
  if (srcIndex === null && fs.existsSync(srcIndexFile)) {
    console.error(`keeping ${src}: library.json and its backup are both unreadable`);
    return;
  }
  const index = srcIndex ?? { assets: [] };
  // Copy media in, then commit the merged index, then remove the source dir.
  // The copies keep every step re-runnable: a crash anywhere leaves at worst
  // duplicate files or duplicate entries to clean up by hand — an index entry
  // can never end up pointing at another account's file.
  const renamed = new Map<string, string>();
  const srcMedia = path.join(src, "media");
  const destMedia = path.join(dest, "media");
  if (fs.existsSync(srcMedia)) {
    fs.mkdirSync(destMedia, { recursive: true });
    for (const name of fs.readdirSync(srcMedia)) {
      if (name === ".DS_Store") continue;
      const to = freeFileName(destMedia, name);
      fs.copyFileSync(path.join(srcMedia, name), path.join(destMedia, to));
      if (to !== name) renamed.set(name, to);
    }
  }
  for (const a of index.assets ?? []) a.fileName = renamed.get(a.fileName) ?? a.fileName;
  for (const t of index.templates ?? [])
    for (const m of t.media ?? []) m.fileName = renamed.get(m.fileName) ?? m.fileName;
  const destIndexFile = path.join(dest, "library.json");
  const destIndex = readJson<LibraryIndexFile>(destIndexFile) ?? { assets: [] };
  destIndex.assets = [...(destIndex.assets ?? []), ...(index.assets ?? [])];
  const known = new Set((destIndex.folders ?? []).map((f) => f.id));
  destIndex.folders = [
    ...(destIndex.folders ?? []),
    ...(index.folders ?? []).filter((f) => !known.has(f.id)),
  ];
  destIndex.templates = [...(destIndex.templates ?? []), ...(index.templates ?? [])];
  fs.writeFileSync(destIndexFile, JSON.stringify(destIndex));
  fs.rmSync(src, { recursive: true, force: true });
}
