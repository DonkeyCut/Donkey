// Owner-side management of a cloud project's share. One row per project
// (CutProjectShare); the row id is the link token viewers open. Viewer-side
// reads live in sharedView.ts.
import { randomBytes } from "node:crypto";
import type { ShareFeatures } from "@/cut/lib/types";
import { prisma } from "@/lib/prisma";
import { getProject } from "./projects";
import { caught, err } from "./util";

export type ShareAccess = "restricted" | "public";
export type { ShareFeatures };

const FEATURE_KEYS = ["chat", "media", "genai", "subtitles", "details"] as const;
const MAX_EMAILS = 50;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** The share id is the link token, and for a public share it is the only
 * gate — so it must be unguessable, not a sequential/fingerprinted cuid. 24
 * random bytes (~192 bits) base64url. */
function newShareToken(): string {
  return randomBytes(24).toString("base64url");
}

export function normalizeFeatures(raw: unknown): ShareFeatures {
  const src = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  return Object.fromEntries(FEATURE_KEYS.map((k) => [k, src[k] === true])) as unknown as ShareFeatures;
}

/** Lowercased, deduped, email-shaped list — or null when the input is not a
 * valid list. */
export function normalizeEmails(raw: unknown): string[] | null {
  if (!Array.isArray(raw) || raw.length > MAX_EMAILS) return null;
  const emails = new Set<string>();
  for (const item of raw) {
    if (typeof item !== "string") return null;
    const email = item.trim().toLowerCase();
    if (!EMAIL_RE.test(email) || email.length > 254) return null;
    emails.add(email);
  }
  return [...emails];
}

type ShareRow = {
  id: string;
  projectId: string;
  userId: string;
  access: string;
  emails: unknown;
  features: unknown;
};

const shareJson = (row: ShareRow) => ({
  id: row.id,
  access: (row.access === "public" ? "public" : "restricted") as ShareAccess,
  emails: normalizeEmails(row.emails) ?? [],
  features: normalizeFeatures(row.features),
});

export const shareCloud = {
  async get(userId: string, projectId: string) {
    if (!(await getProject(userId, projectId))) return err("Project not found.", 404);
    const row = await prisma.cutProjectShare.findUnique({ where: { projectId } });
    return Response.json({ share: row && row.userId === userId ? shareJson(row) : null });
  },

  async put(userId: string, projectId: string, req: Request) {
    try {
      if (!(await getProject(userId, projectId))) return err("Project not found.", 404);
      const body = (await req.json()) as {
        access?: unknown;
        emails?: unknown;
        features?: unknown;
      };
      const access = body.access === "public" ? "public" : "restricted";
      const emails = normalizeEmails(body.emails ?? []);
      if (!emails) return err("Bad email list.", 400);
      const features = normalizeFeatures(body.features);
      const data = { access, emails, features: { ...features } };
      const row = await prisma.cutProjectShare.upsert({
        where: { projectId },
        create: { id: newShareToken(), projectId, userId, ...data },
        update: data,
      });
      return Response.json({ share: shareJson(row) });
    } catch (e) {
      return caught(e, "Could not save the share.");
    }
  },

  async remove(userId: string, projectId: string) {
    try {
      await prisma.cutProjectShare.deleteMany({ where: { projectId, userId } });
      return Response.json({ ok: true });
    } catch (e) {
      return caught(e, "Could not remove the share.");
    }
  },
};
