import { mkdirSync, writeFileSync } from "node:fs";
import { serializeEnvironment } from "./prepare-vercel-build.mjs";

const { VERCEL_TOKEN: token, VERCEL_PROJECT_ID: projectId, VERCEL_ORG_ID: orgId } = process.env;
if (!token || !projectId || !orgId) throw new Error("Missing Vercel deployment credentials");

async function readVercel(path) {
  const url = new URL(path, "https://api.vercel.com");
  url.searchParams.set("teamId", orgId);
  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new Error(`Vercel ${path} returned HTTP ${response.status}`);
  return response.json();
}

// Project-scoped tokens can read these endpoints. CLI pull also requests the
// team record, which fails: https://github.com/vercel/vercel/issues/17506.
const project = await readVercel(`/v9/projects/${encodeURIComponent(projectId)}`);
if (project.id !== projectId || project.accountId !== orgId || project.rootDirectory !== "site") {
  throw new Error("Vercel project must belong to the configured team and use site/ as its root");
}
const { env } = await readVercel(`/v3/env/pull/${encodeURIComponent(projectId)}/production`);
if (!env || typeof env !== "object" || Object.values(env).some(value => typeof value !== "string")) {
  throw new Error("Vercel returned an invalid production environment");
}

// Match the settings consumed by the pinned Vercel CLI's build command.
const settings = Object.fromEntries([
  "createdAt", "framework", "devCommand", "installCommand", "buildCommand",
  "outputDirectory", "rootDirectory", "directoryListing", "nodeVersion",
].map(key => [key, project[key]]));
if (project.analytics?.id && (!project.analytics.disabledAt || project.analytics.enabledAt > project.analytics.disabledAt)) {
  settings.analyticsId = project.analytics.id;
}
const directory = new URL("../../.vercel/", import.meta.url);
mkdirSync(directory, { recursive: true });
writeFileSync(new URL("project.json", directory), JSON.stringify({
  projectId, orgId, projectName: project.name, settings,
}, null, 2));
writeFileSync(new URL(".env.production.local", directory), serializeEnvironment(env), { mode: 0o600 });
console.log("Downloaded Donkey production build settings");
