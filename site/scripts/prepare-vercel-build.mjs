import { chmodSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parse } from "dotenv";

// Vercel keeps runtime secrets unreadable. Prerendering needs database and
// blog media access; auth initializes during the build, and public keys inline.
export const buildKeys = [
  "DATABASE_URL", "DIRECT_URL", "BETTER_AUTH_SECRET", "NEXT_PUBLIC_POSTHOG_KEY",
  "R2_ACCOUNT_ID", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY",
];

export function prepareBuildEnvironment(pulled, credentials) {
  if (!credentials || typeof credentials !== "object" || Array.isArray(credentials)) {
    throw new Error("VERCEL_BUILD_ENV must be a JSON object");
  }
  const values = parse(pulled);
  for (const key of buildKeys) {
    const value = credentials[key];
    if (typeof value !== "string" || !value || value === "[SENSITIVE]") {
      throw new Error(`VERCEL_BUILD_ENV is missing ${key}`);
    }
    values[key] = value;
  }
  for (const [key, value] of Object.entries(values)) {
    if (value !== "[SENSITIVE]") continue;
    if (key.startsWith("NEXT_PUBLIC_")) {
      throw new Error(`Public build variable ${key} needs an explicit build credential`);
    }
    delete values[key];
  }
  return Object.entries(values).map(([key, value]) => {
    // dotenv preserves literal backslashes inside single quotes and backticks.
    const quote = ["'", "`"].find(candidate => !value.includes(candidate));
    if (!quote) throw new Error(`Build variable ${key} contains unsupported quote delimiters`);
    return `${key}=${quote}${value}${quote}`;
  }).join("\n") + "\n";
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const file = new URL("../../.vercel/.env.production.local", import.meta.url);
  const credentials = JSON.parse(process.env.VERCEL_BUILD_ENV ?? "null");
  const output = prepareBuildEnvironment(readFileSync(file, "utf8"), credentials);
  chmodSync(file, 0o600);
  writeFileSync(file, output, { mode: 0o600 });
}
