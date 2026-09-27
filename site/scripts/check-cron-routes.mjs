import { readFileSync } from "node:fs";

// Cron handlers must execute on every invocation, including builds without
// runtime secrets. A prerendered response would consume the scheduled call.
const readJson = path => JSON.parse(readFileSync(new URL(path, import.meta.url), "utf8"));
const { crons } = readJson("../vercel.json");
const { routes } = readJson("../.next/prerender-manifest.json");
const cached = crons.filter(({ path }) => Object.hasOwn(routes, path));

if (cached.length) {
  throw new Error(`Cron routes were prerendered: ${cached.map(({ path }) => path).join(", ")}`);
}

console.log(`Verified ${crons.length} cron routes execute at request time.`);
