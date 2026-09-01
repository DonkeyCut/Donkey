// Runs in postinstall, after patch-package. The patch in patches/ bounds how
// many decoded frames mediabunny's decode pump keeps in flight; it belongs to
// one mediabunny version and retires when upstream carries the fix. A bump
// stops the install here until someone has looked.
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const site = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const patches = readdirSync(path.join(site, "patches")).filter((f) => /^mediabunny\+.*\.patch$/.test(f));
const installed = JSON.parse(readFileSync(path.join(site, "node_modules/mediabunny/package.json"), "utf8")).version;
const sink = readFileSync(path.join(site, "node_modules/mediabunny/dist/modules/src/media-sink.js"), "utf8");

const patched = patches.map((f) => f.slice("mediabunny+".length, -".patch".length));
if (patched.length === 1 && patched[0] === installed && sink.includes("this.inFlight++")) process.exit(0);

console.error(`
mediabunny is ${installed}; the decode-pump patch in site/patches/ is for ${patched.join(", ") || "no version"}.

Open node_modules/mediabunny/dist/modules/src/media-sink.js and read computeMaxQueueSize and
the pump loops that call getDecodeQueueSize().
  Upstream now counts frames in flight (submitted minus output) and starts with a small
  head start: delete site/patches/mediabunny+*.patch, remove this script and patch-package
  from postinstall and devDependencies, and run the perf eval's playback bucket.
  Upstream still throttles on decodeQueueSize with a 40-packet head start: re-apply the
  patch's six edits to the module and both bundles, run \`npx patch-package mediabunny\`,
  and commit the new patch file.
`);
process.exit(1);
