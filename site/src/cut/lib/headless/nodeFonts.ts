import { setFontInstaller } from "../fontAssets";
import { aliasFaceEm } from "../fontEm";
import { forgetTextWidths } from "../textFit";
import { registerFonts } from "../types";

/**
 * Fonts for a headless render.
 *
 * scripts/stage-cut-fonts.mjs stages the faces the page declares as files, and
 * their latin subset loads into skia here,
 * under both their own names and the names the base system stacks ask for
 * ("SF Pro Display", "Impact", "New York"). After this
 * runs, `fontStack` resolves every Cut font id to a family skia can draw, and
 * a title rendered headless looks like the title in the tab.
 *
 * A project's own uploaded font files go the same way, through the installer
 * the font-assets module hands its bytes to: skia reads faces from disk, so
 * the bytes land in a scratch file first.
 */

interface FontManifestEntry {
  /** The Cut font id, for the families the font menu offers. Absent on the
   * stand-ins, which only answer to their aliases. */
  id?: string;
  family: string;
  aliases?: string[];
  /** The latin face of each weight and slant. */
  files: string[];
}

/** Load the staged font files into skia. Returns how many families landed;
 * 0 when the directory is missing, which leaves text to whatever faces the
 * host itself has. */
export async function installHeadlessFonts(): Promise<number> {
  try {
    const [skia, fs, path] = await Promise.all([
      import("skia-canvas"),
      import("node:fs/promises"),
      import("node:path"),
    ]);
    // Registered before the staged files are read: a project's uploaded font
    // is a separate capability, and it should survive an image built without
    // the staging step.
    setFontInstaller(async (family, bytes) => {
      const os = await import("node:os");
      const scratch = await fs.mkdtemp(path.join(os.tmpdir(), "cut-font-"));
      const file = path.join(scratch, `${family}.font`);
      await fs.writeFile(file, Buffer.from(bytes));
      skia.FontLibrary.use(family, [file]);
    });

    const dir = path.join(process.cwd(), "public", "cut-fonts");
    const manifest = JSON.parse(
      await fs.readFile(path.join(dir, "manifest.json"), "utf8")
    ) as FontManifestEntry[];

    let loaded = 0;
    for (const entry of manifest) {
      const files = entry.files.map((f) => path.join(dir, f));
      try {
        skia.FontLibrary.use(entry.family, files);
        for (const alias of entry.aliases ?? []) {
          skia.FontLibrary.use(alias, files);
          aliasFaceEm(alias, entry.family);
        }
      } catch {
        continue; // one unreadable face costs that font alone
      }
      if (entry.id)
        registerFonts([
          { id: entry.id, label: entry.family, stack: `"${entry.family}"` },
        ]);
      loaded++;
    }
    // Faces installed after a line was measured would leave that line broken
    // against the fallback for the life of the process.
    if (loaded > 0) forgetTextWidths();
    return loaded;
  } catch {
    return 0;
  }
}
