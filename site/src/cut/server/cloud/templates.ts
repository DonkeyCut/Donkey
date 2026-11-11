// The template gallery's storage and API. Templates are Donkey's own assets,
// kept in R2 beside the accounts' media rather than in the source tree:
//
//   cut/templates/index.json            every published template, in order
//   cut/templates/<id>/project.json     the template's project document
//   cut/templates/<id>/media/<file>     the media its assets name
//   cut/templates/<id>/poster.jpg       the gallery card's still
//   cut/templates/<id>/frames/<clip>.jpg each video clip's first frame, small
//   cut/templates/<id>/peaks.json       each sounding asset's waveform peaks
//
// Anyone can read a published template, the way a public share reads: the
// gallery page and the template's read-only editor need no session. Copying
// one into an account needs one, and copies its media server-side under the
// new project, quota-exempt, the way the signup starter project is seeded.
import { randomUUID } from "node:crypto";
import type { ProjectDoc, ShareFeatures } from "@/cut/lib/types";
import type { GalleryTemplate, TemplateIndex } from "@/cut/lib/templateGallery";
import type { Prisma } from "@/generated/prisma/client";
import { auth } from "@/lib/auth";
import { cloudProjectsFull } from "@/lib/billing/project-limit-server";
import { prisma } from "@/lib/prisma";
import { UserError } from "@/cut/lib/userError";
import { mediaObjectUrl, mediaUrlLifetime } from "./mediaCdn";
import { copy, getObject, head, projectMediaKey } from "./r2";
import { caught, decodeFileParam, err, redirect } from "./util";

const TEMPLATE_ROOT = "cut/templates";
export const TEMPLATE_INDEX_KEY = `${TEMPLATE_ROOT}/index.json`;
export const templateKey = (id: string, rest: string) => `${TEMPLATE_ROOT}/${id}/${rest}`;
export const templateMediaKey = (id: string, fileName: string) => templateKey(id, `media/${fileName}`);
export const TEMPLATE_POSTER = "poster.jpg";
export const TEMPLATE_PEAKS = "peaks.json";
export const templateFrameKey = (id: string, clipId: string) => templateKey(id, `frames/${clipId}.jpg`);
// The frames' height: the timeline's strip at twice its size.
export const TEMPLATE_FRAME_H = 96;
// A clip id names one object; anything else never reaches the bucket.
const CLIP_ID = /^[\w-]+$/;

// How long a server instance trusts its read of the index before reading R2
// again; a publish shows up within this window.
const INDEX_TTL_MS = 60_000;
// How long browsers and the edge may keep the index and a document.
const PUBLIC_CACHE = "public, max-age=60, s-maxage=300";
// A redirect to signed media lives well inside the token's own window.
const REDIRECT_CACHE = "public, max-age=900";
// The presign batch the viewer sends is capped like a share's.
const PRESIGN_MAX = 200;

// What the read-only viewer shows of a template: all of it, without a chat
// or a details panel.
const TEMPLATE_FEATURES: ShareFeatures = { chat: false, media: true, genai: true, subtitles: true, details: false };

const NOT_FOUND = new UserError("template_missing", "This template isn't available anymore.");
const SIGN_IN = new UserError("template_sign_in_required", "Sign in to use this template.");
const COPY_FAILED = new UserError("template_use_failed", "Could not create the project.");
const PROJECT_LIMIT = new UserError("project_limit", "This account is at its free project limit. Upgrade to Pro to make more projects.");
const HTTP_PAYMENT_REQUIRED = 402;

// --- Reads ----------------------------------------------------------------

let index: { at: number; value: TemplateIndex } | null = null;
const docs = new Map<string, { version: string; doc: ProjectDoc }>();

export async function readTemplateIndex(): Promise<TemplateIndex> {
  if (index && Date.now() - index.at < INDEX_TTL_MS) {
    return index.value;
  }
  const obj = await getObject(TEMPLATE_INDEX_KEY);
  const value = obj ? (JSON.parse(obj.bytes.toString("utf8")) as TemplateIndex) : { templates: [] };
  index = { at: Date.now(), value };
  return value;
}

async function publishedTemplate(id: string): Promise<GalleryTemplate | null> {
  return (await readTemplateIndex()).templates.find((t) => t.id === id) ?? null;
}

/** A template's document, read once per published version. */
async function templateDoc(t: GalleryTemplate): Promise<ProjectDoc | null> {
  const cached = docs.get(t.id);
  if (cached?.version === t.version) {
    return cached.doc;
  }
  const obj = await getObject(templateKey(t.id, "project.json"));
  if (!obj) {
    return null;
  }
  // Every copy of the template, whatever shelf it lands on, says where it
  // came from.
  const doc: ProjectDoc = { ...(JSON.parse(obj.bytes.toString("utf8")) as ProjectDoc), fromTemplate: t.id };
  docs.set(t.id, { version: t.version, doc });
  return doc;
}

/** Every file a template's document names. */
function templateFiles(doc: ProjectDoc): Set<string> {
  return new Set((doc.assets ?? []).map((a) => a.fileName).filter(Boolean));
}

const cachedRedirect = (url: string) => redirect(url, { "Cache-Control": REDIRECT_CACHE });

// --- Copy into an account ---------------------------------------------------

/** Land a template as a new cloud project of the account's: media copied
 * under it server-side and quota-exempt, the document stamped new. */
async function copyToAccount(userId: string, t: GalleryTemplate, name: string): Promise<string> {
  const source = await templateDoc(t);
  if (!source) {
    throw NOT_FOUND;
  }
  const id = randomUUID();
  const now = Date.now();
  const doc: ProjectDoc = { ...source, id: undefined, name, createdAt: now, updatedAt: now, folderId: null };
  const media = await Promise.all(
    [...templateFiles(source)].map(async (fileName) => {
      const info = await head(templateMediaKey(t.id, fileName));
      if (!info) {
        throw NOT_FOUND;
      }
      await copy(templateMediaKey(t.id, fileName), projectMediaKey(userId, id, fileName));
      return { fileName, bytes: info.bytes, mime: info.mime };
    })
  );
  await prisma.$transaction(async (tx) => {
    await tx.cutProject.create({
      data: { id, userId, name, doc: doc as unknown as Prisma.InputJsonValue },
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
  });
  return id;
}

// --- Handlers -----------------------------------------------------------------

export const templatesApi = {
  /** The gallery's index. */
  async list() {
    try {
      return Response.json(await readTemplateIndex(), { headers: { "Cache-Control": PUBLIC_CACHE } });
    } catch (e) {
      return caught(e, "Could not read the templates.");
    }
  },

  /** The viewer's meta, in the shape a share's meta answers. */
  async meta(id: string) {
    const t = await publishedTemplate(id);
    if (!t) {
      return err(NOT_FOUND, 404);
    }
    return Response.json(
      { projectId: t.id, name: t.name.en, features: TEMPLATE_FEATURES },
      { headers: { "Cache-Control": PUBLIC_CACHE } }
    );
  },

  async doc(id: string, projectId: string, req: Request) {
    const t = projectId === id ? await publishedTemplate(id) : null;
    const doc = t ? await templateDoc(t) : null;
    if (!t || !doc) {
      return err(NOT_FOUND, 404);
    }
    const headers = { "x-cut-doc-version": t.version, "Cache-Control": PUBLIC_CACHE };
    if (req.method === "HEAD") {
      return new Response(null, { headers });
    }
    return Response.json(doc, { headers });
  },

  async media(id: string, projectId: string, file: string) {
    const t = projectId === id ? await publishedTemplate(id) : null;
    const doc = t ? await templateDoc(t) : null;
    const fileName = decodeFileParam(file);
    if (!t || !doc || !templateFiles(doc).has(fileName)) {
      return err(NOT_FOUND, 404);
    }
    return cachedRedirect(mediaObjectUrl(templateMediaKey(id, fileName), { version: t.version }));
  },

  async presignGet(id: string, req: Request) {
    try {
      const t = await publishedTemplate(id);
      const doc = t ? await templateDoc(t) : null;
      if (!t || !doc) {
        return err(NOT_FOUND, 404);
      }
      const { items } = (await req.json()) as { items?: { projectId?: string; fileName?: string }[] };
      if (!Array.isArray(items) || items.length > PRESIGN_MAX) {
        return err("Bad request.", 400);
      }
      const files = templateFiles(doc);
      const urls = items
        .filter((i) => i.projectId === id && typeof i.fileName === "string" && files.has(i.fileName))
        .map((i) => ({
          projectId: id,
          fileName: i.fileName!,
          url: mediaObjectUrl(templateMediaKey(id, i.fileName!), { version: t.version }),
        }));
      return Response.json({ urls, expiresIn: mediaUrlLifetime() });
    } catch (e) {
      return caught(e, "Could not sign the media URLs.");
    }
  },

  /** The card's still. */
  async poster(id: string) {
    const t = await publishedTemplate(id);
    if (!t) {
      return err(NOT_FOUND, 404);
    }
    return cachedRedirect(mediaObjectUrl(templateKey(id, TEMPLATE_POSTER), { version: t.version }));
  },

  /** A video clip's first frame, which the template page's timeline tiles
   * across the clip in place of decoding the footage. */
  async frame(id: string, clipId: string) {
    const t = CLIP_ID.test(clipId) ? await publishedTemplate(id) : null;
    if (!t) {
      return err(NOT_FOUND, 404);
    }
    return cachedRedirect(mediaObjectUrl(templateFrameKey(id, clipId), { version: t.version }));
  },

  /** The waveform peaks of every asset an audio clip plays, keyed by asset
   * id, which the template page's timeline draws in place of decoding the
   * sound. */
  async peaks(id: string) {
    const t = await publishedTemplate(id);
    if (!t) {
      return err(NOT_FOUND, 404);
    }
    return cachedRedirect(mediaObjectUrl(templateKey(id, TEMPLATE_PEAKS), { version: t.version }));
  },

  /** Copy a template into the signed-in account's cloud. */
  async copy(id: string, req: Request) {
    try {
      const session = await auth.api.getSession({ headers: req.headers });
      if (!session?.user) {
        return err(SIGN_IN, 401);
      }
      const t = await publishedTemplate(id);
      if (!t) {
        return err(NOT_FOUND, 404);
      }
      if (await cloudProjectsFull(session.user.id)) {
        return err(PROJECT_LIMIT, HTTP_PAYMENT_REQUIRED);
      }
      const body = (await req.json().catch(() => ({}))) as { name?: string };
      const name = body.name?.trim() || t.name.en;
      return Response.json({ projectId: await copyToAccount(session.user.id, t, name) });
    } catch (e) {
      if (e === NOT_FOUND) {
        return err(NOT_FOUND, 404);
      }
      return caught(e, COPY_FAILED);
    }
  },
};
