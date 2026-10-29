import { copyFile, mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { pluginFiles } from "../src/clients/chatgpt/plugin";

// The ZIP the OpenAI portal imports as a new draft of the Donkey Cut plugin.
//   bun run scripts/build-chatgpt-plugin.ts --demo <reviewer-accessible video URL>
const demo = process.argv[process.argv.indexOf("--demo") + 1];
if (!process.argv.includes("--demo") || !demo?.startsWith("https://")) {
  throw new Error("Pass --demo <https URL of the demo recording>; review requires one.");
}
const root = path.resolve(import.meta.dir, "..");
const outdir = path.join(root, "dist/chatgpt-plugin");
const zipPath = path.join(root, "dist/donkey-cut-chatgpt-plugin.zip");
await rm(outdir, { recursive: true, force: true });
await rm(zipPath, { force: true });

// Write every file, then zip the folder's contents so the manifest sits at the root.
for (const file of pluginFiles(demo)) {
  const target = path.join(outdir, file.path);
  await mkdir(path.dirname(target), { recursive: true });
  if ("from" in file) {
    await copyFile(path.join(root, file.from), target);
    continue;
  }
  await writeFile(target, file.text);
}
const zip = Bun.spawnSync(["zip", "-qrX", zipPath, "."], { cwd: outdir });
if (zip.exitCode !== 0) throw new Error(`zip failed: ${zip.stderr.toString()}`);
console.log(`ChatGPT plugin: ${zipPath}`);
