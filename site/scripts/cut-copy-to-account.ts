#!/usr/bin/env bun
/**
 * Copy a project folder from a Mac library (~/Movies/DonkeyCut or
 * ~/Movies/DonkeyCutDev) into one account's cloud. It drives the same handlers
 * the /api/cut-cloud routes call — create, presign, upload, complete, save —
 * so quota, usage and media rows land exactly as an in-app "Move to Cloud"
 * leaves them. The source folder is left alone.
 *
 * Run from site/ with production credentials in the environment:
 *   bun run scripts/cut-copy-to-account.ts "<project folder>" <email>
 */

import fs from "node:fs/promises";
import path from "node:path";
import type { ProjectDoc } from "../src/cut/lib/types";
import { mediaCloud } from "../src/cut/server/cloud/media";
import { projectsCloud } from "../src/cut/server/cloud/projects";
import { contentTypeFor } from "../src/cut/server/serveFile";
import { prisma } from "../src/lib/prisma";

const [dir, email] = process.argv.slice(2);
if (!dir || !email) {
  console.error('usage: bun run scripts/cut-copy-to-account.ts "<project folder>" <email>');
  process.exit(1);
}

// The handlers take Requests; only the body and the URL's query matter.
const ROUTE = "http://localhost/api/cut/projects";
const jsonRequest = (url: string, method: string, body: unknown) =>
  new Request(url, { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

const user = await prisma.user.findUnique({ where: { email }, select: { id: true } });
if (!user) {
  console.error(`No account for ${email}.`);
  process.exit(1);
}
const doc = JSON.parse(await fs.readFile(path.join(dir, "project.json"), "utf8")) as ProjectDoc;

// Create the cloud project, then land each media file under the name the
// cloud claims for it.
const created = (await (
  await projectsCloud.create(user.id, jsonRequest(ROUTE, "POST", { name: doc.name, aspect: doc.aspect }))
).json()) as { id?: string; error?: string };
if (!created.id) throw new Error(created.error ?? "Could not create the project.");
const names = new Map<string, string>();
// A block asset (a solid card) has no file, so only assets with one upload.
for (const fileName of new Set(doc.assets.map((a) => a.fileName).filter(Boolean))) {
  const bytes = await fs.readFile(path.join(dir, "media", fileName));
  const mime = contentTypeFor(fileName);
  const claim = (await (
    await mediaCloud.presign(user.id, created.id, jsonRequest(ROUTE, "POST", { fileName, mime, bytes: bytes.length }))
  ).json()) as { fileName?: string; key?: string; url?: string; error?: string };
  if (!claim.url || !claim.key || !claim.fileName) throw new Error(claim.error ?? `Could not presign ${fileName}.`);
  const put = await fetch(claim.url, { method: "PUT", headers: { "Content-Type": mime }, body: bytes });
  if (!put.ok) throw new Error(`Upload of ${fileName} failed (${put.status}).`);
  const done = await mediaCloud.complete(user.id, jsonRequest(ROUTE, "POST", { key: claim.key }));
  if (!done.ok) throw new Error(`Could not complete ${fileName} (${done.status}).`);
  names.set(fileName, claim.fileName);
  console.log(`uploaded ${fileName}`);
}

// Save the doc against the claimed names; the cloud stamps its own id.
const copied: ProjectDoc = {
  ...doc,
  id: undefined,
  folderId: null,
  assets: doc.assets.map((a) => ({ ...a, fileName: names.get(a.fileName) ?? a.fileName })),
};
const saved = await projectsCloud.put(user.id, created.id, jsonRequest(`${ROUTE}/${created.id}`, "PUT", copied));
if (!saved.ok) throw new Error(`Could not save the project (${saved.status}).`);
console.log(`project ${created.id}`);
process.exit(0);
