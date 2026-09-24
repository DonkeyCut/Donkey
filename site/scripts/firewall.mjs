import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";

const site = fileURLToPath(new URL("../", import.meta.url));
const rules = ["export-list-reads", "all-apis", "frontend"].map((name) =>
  JSON.parse(readFileSync(new URL(`../firewall/${name}.json`, import.meta.url), "utf8")));
const cli = ["--yes", "vercel@59.26.0"];
const scope = ["--scope", "donkeycut", "--project", "donkey"];

function vercel(args, capture = false) {
  return execFileSync("npx", [...cli, "firewall", ...args, ...scope], {
    cwd: site,
    encoding: "utf8",
    stdio: capture ? ["ignore", "pipe", "inherit"] : "inherit",
  });
}

// Ignore provider IDs and unset optional fields; keep every effective condition.
function normalize(value) {
  if (Array.isArray(value)) return value.map(normalize);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value)
      .filter(([key, item]) => key !== "id" && item != null && !(key === "neg" && item === false))
      .map(([key, item]) => [key, normalize(item)]));
  }
  return value;
}

function matches(rule, actual) {
  const fields = ["name", "description", "active", "conditionGroup", "action"];
  return isDeepStrictEqual(normalize(rule), normalize(Object.fromEntries(fields.map((key) => [key, actual[key]]))));
}

const mode = process.argv[2];
if (mode !== "check" && mode !== "stage") {
  throw new Error("Usage: node scripts/firewall.mjs check|stage");
}
const remote = JSON.parse(vercel(["rules", "list", "--json"], true));
if (remote.hasDraft) {
  throw new Error("Resolve pending Vercel firewall changes before checking or staging these rules.");
}
const changes = rules.flatMap((rule) => {
  const existing = remote.rules.filter((entry) => entry.name === rule.name);
  if (existing.length > 1) throw new Error(`Multiple rules named ${rule.name}; resolve the duplicate in Vercel.`);
  return existing.length === 1 && matches(rule, existing[0]) ? [] : [{ rule, existing: existing[0] }];
});
if (changes.length === 0) {
  console.log("Published firewall rules match the repository.");
  process.exit(0);
}
if (mode === "check") {
  throw new Error(`Firewall drift: ${changes.map(({ rule }) => rule.name).join(", ")}. Run npm run firewall:stage to prepare an update.`);
}
for (const { rule, existing } of changes) {
  const operation = existing ? ["edit", existing.id] : ["add"];
  vercel(["rules", ...operation, "--json", JSON.stringify(rule), "--yes"]);
}
vercel(["diff"]);
console.log("Review the draft, then publish: npx --yes vercel@59.26.0 firewall publish --scope donkeycut --project donkey");
