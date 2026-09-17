// The worker bundle is built once and runs in production, so the bundler
// folds process.env.NODE_ENV at build time. A build that folded it to
// "development" points every hosted call at localhost, and the container's
// only symptom is "fetch failed" on each job. Refuse to ship that bundle.
import { readFileSync } from "node:fs";

const bundle = readFileSync("dist/cut-worker/main.js", "utf8");
if (bundle.includes("http://localhost:3000")) {
  console.error("worker bundle points hosted calls at localhost: CUT_HOSTED_ORIGIN (src/cut/lib/hosts.ts) folded with NODE_ENV unset at build time.");
  process.exit(1);
}
