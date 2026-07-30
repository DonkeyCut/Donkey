// The starter project a new account is seeded with at signup: a finished
// example cut (doc + media + its AI chat thread) sourced from public/cut-starter.
// Each account gets its own copy — the doc and thread rows are theirs, and the
// media bytes are copied under their R2 prefix — so deleting the project (or
// single files from it) removes only that account's copy through the normal
// cascade. The seeded media rows are quotaExempt: they never count toward the
// storage quota, while anything the user later adds to the project counts as
// usual.
//
// The canonical bytes live twice: in public/cut-starter/media (the source of
// truth, served by the site) and mirrored lazily under cut/starter/ in R2 so
// each signup is a cheap server-side copy instead of a re-upload.
import fs from "node:fs/promises";
import path from "node:path";
import { DONKEYCUT_CANONICAL } from "@/cut/lib/hosts";
import { starterProjectId } from "@/cut/lib/starter";
import type { ProjectDoc } from "@/cut/lib/types";
import type { Prisma } from "@/generated/prisma/client";
import { prisma } from "@/lib/prisma";
import { contentTypeFor } from "../serveFile";
import { copy, head, projectMediaKey, putObject } from "./r2";

const STARTER_DIR = "cut-starter";
const starterMediaKey = (fileName: string) => `cut/starter/media/${fileName}`;

/** A file from public/cut-starter — from disk where the public folder is on the
 * filesystem (dev, node servers), else fetched from the canonical host. */
async function readStarterFile(rel: string): Promise<Buffer> {
  try {
    return await fs.readFile(path.join(process.cwd(), "public", STARTER_DIR, rel));
  } catch {
    const url = `${DONKEYCUT_CANONICAL}/${STARTER_DIR}/${rel.split("/").map(encodeURIComponent).join("/")}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`starter file ${rel} unavailable (${res.status})`);
    return Buffer.from(await res.arrayBuffer());
  }
}

/** Make sure the canonical R2 mirror of one starter media file exists, and
 * report its size and type. The first signup after a template change pays the
 * upload; every later one just HEADs. */
async function ensureStarterObject(fileName: string): Promise<{ bytes: number; mime: string }> {
  const key = starterMediaKey(fileName);
  const existing = await head(key);
  if (existing && existing.bytes > 0) {
    return { bytes: existing.bytes, mime: existing.mime || contentTypeFor(fileName) };
  }
  const buf = await readStarterFile(`media/${fileName}`);
  const mime = contentTypeFor(fileName);
  await putObject(key, buf, mime);
  return { bytes: buf.length, mime };
}

/** Seed the account's starter project: copy the media into its R2 prefix, then
 * land the project, media rows, and chat threads in one transaction. Idempotent
 * via the derived project id, and no usage is added — the rows are quotaExempt. */
export async function seedStarterProject(userId: string): Promise<void> {
  const id = starterProjectId(userId);
  if (await prisma.cutProject.findUnique({ where: { id } })) return;

  const doc = JSON.parse(String(await readStarterFile("project.json"))) as ProjectDoc;
  const threads = JSON.parse(String(await readStarterFile("chat.json"))) as { id: string }[];
  const now = Date.now();
  doc.createdAt = now;
  doc.updatedAt = now;

  const fileNames = [...new Set(doc.assets.map((a) => a.fileName))];
  const media = await Promise.all(
    fileNames.map(async (fileName) => {
      const info = await ensureStarterObject(fileName);
      await copy(starterMediaKey(fileName), projectMediaKey(userId, id, fileName));
      return { fileName, ...info };
    })
  );

  await prisma.$transaction(async (tx) => {
    await tx.cutProject.create({
      data: { id, userId, name: doc.name, doc: doc as unknown as Prisma.InputJsonValue },
    });
    await tx.cutMediaObject.createMany({
      data: media.map((m) => ({
        userId,
        projectId: id,
        r2Key: projectMediaKey(userId, id, m.fileName),
        fileName: m.fileName,
        mime: m.mime,
        bytes: m.bytes,
        kind: "media",
        uploadState: "complete",
        quotaExempt: true,
      })),
    });
    await tx.cutChatThread.createMany({
      data: threads.map((t) => ({
        projectId: id,
        id: t.id,
        userId,
        data: t as unknown as Prisma.InputJsonValue,
      })),
    });
  });
}
