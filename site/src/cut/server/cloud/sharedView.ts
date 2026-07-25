// Viewer-side reads of a shared cloud project. Every handler resolves the
// share token first, then reads the OWNER's rows and presigns the owner's R2
// keys — the viewer's session (if any) only ever gates access. The server is
// the content boundary: the filtered doc and the media allowlist are what
// decide which bytes a viewer can reach; the client's tab hiding is
// presentation only. Copying a share lives in copyQueue.ts.
import type { ProjectDoc, StoredAsset } from "@/cut/lib/types";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { MEDIA_TOKEN_TTL_SECONDS, mediaCdnEnabled, mediaCdnUrl } from "./mediaCdn";
import { presignGet, presignGetLifetime, projectMediaKey } from "./r2";
import { normalizeEmails, normalizeFeatures, type ShareFeatures } from "./share";
import { shareCacheHeaders, shareRedirectHeaders } from "./shareCache";
import { caught, decodeFileParam, err, redirect } from "./util";

const PRESIGN_GET_BATCH_MAX = 500;
/** How long a media redirect may be reused. It has to stay inside the life of
 * the URL it carries, or the edge would keep handing out a dead link. */
const MEDIA_REDIRECT_TTL = 15 * 60;

/** A viewer-facing URL for one of the owner's objects: the edge Worker when
 * this deployment has it configured, a presigned R2 URL otherwise. */
const sharedMediaUrl = (key: string): Promise<string> =>
  Promise.resolve(mediaCdnUrl(key) ?? presignGet(key));

/** Redirect lifetime that matches whichever URL kind was minted. */
const mediaRedirectTtl = () =>
  mediaCdnEnabled() ? Math.floor(MEDIA_TOKEN_TTL_SECONDS / 5) : MEDIA_REDIRECT_TTL;

/** What the client is told a media batch is good for, so it re-mints ahead of
 * expiry rather than after a 403. */
const mediaUrlLifetime = () =>
  mediaCdnEnabled() ? MEDIA_TOKEN_TTL_SECONDS : presignGetLifetime();

export type ShareRow = NonNullable<
  Awaited<ReturnType<typeof prisma.cutProjectShare.findUnique>>
>;

interface ShareView {
  share: ShareRow;
  features: ShareFeatures;
}

/** Resolve who may see this share: the row must exist, and a restricted share
 * additionally needs a signed-in viewer who is the owner or an invitee.
 * Returns the error Response to send when access fails. */
export async function resolveShare(token: string, req: Request): Promise<ShareView | Response> {
  if (!token || token.length > 64) return err("Share not found.", 404);
  const share = await prisma.cutProjectShare.findUnique({ where: { id: token } });
  if (!share) return err("Share not found.", 404);
  const features = normalizeFeatures(share.features);
  if (share.access === "public") return { share, features };
  const session = await auth.api.getSession({ headers: req.headers });
  if (!session?.user) return err("Sign in to view this project.", 401);
  const email = session.user.email?.toLowerCase() ?? "";
  const invited = (normalizeEmails(share.emails) ?? []).includes(email);
  if (session.user.id !== share.userId && !invited) {
    return err("You don't have access to this project.", 403);
  }
  return { share, features };
}

async function ownerProject(share: ShareRow) {
  return prisma.cutProject.findFirst({ where: { id: share.projectId, userId: share.userId } });
}

/** The asset set a viewer may see: everything playback needs (referenced by a
 * clip), plus each optional surface's assets when that surface is shared.
 * Untagged assets belong to the Media panel; origin-tagged ones to the
 * generate panels; chat-tagged ones to chat. The Library is never shared. */
function allowedAssets(doc: ProjectDoc, features: ShareFeatures): StoredAsset[] {
  const assets = Array.isArray(doc.assets) ? doc.assets : [];
  const referenced = new Set<string>([
    ...(Array.isArray(doc.clips) ? doc.clips : []).map((c) => c.assetId),
    ...(Array.isArray(doc.audioClips) ? doc.audioClips : []).map((c) => c.assetId),
  ]);
  return assets.filter((a) => {
    if (referenced.has(a.id)) return true;
    if (a.chatId) return features.chat;
    if (a.origin) return features.genai;
    return features.media;
  });
}

export function filterDocForShare(doc: ProjectDoc, features: ShareFeatures): ProjectDoc {
  const filtered: ProjectDoc = {
    ...doc,
    assets: allowedAssets(doc, features),
    templates: undefined,
    folderId: null,
    ui: undefined,
    publish: features.details ? doc.publish : undefined,
    notes: features.details ? doc.notes : undefined,
    genvideo: features.genai ? doc.genvideo : undefined,
    renders: features.chat ? doc.renders : undefined,
    // The transcript ships only when Subtitles is shared: the cue text and
    // word timings are content, so a hidden panel is not enough — the doc
    // itself must not carry them. Without it the viewer's playback shows no
    // burned-in captions either, which is the point of the toggle.
    subtitles: features.subtitles ? doc.subtitles : undefined,
  };
  return filtered;
}

async function allowedFileNames(share: ShareRow, features: ShareFeatures): Promise<Set<string>> {
  const row = await ownerProject(share);
  if (!row) return new Set();
  return new Set(allowedAssets(row.doc as unknown as ProjectDoc, features).map((a) => a.fileName));
}

export const sharedView = {
  async meta(token: string, req: Request) {
    const view = await resolveShare(token, req);
    if (view instanceof Response) return view;
    const row = await ownerProject(view.share);
    if (!row) return err("Share not found.", 404);
    return Response.json(
      {
        projectId: view.share.projectId,
        name: row.name,
        access: view.share.access,
        features: view.features,
      },
      { headers: shareCacheHeaders(view.share, row.updatedAt, { meta: true }) }
    );
  },

  async doc(token: string, id: string, req: Request) {
    const view = await resolveShare(token, req);
    if (view instanceof Response) return view;
    if (id !== view.share.projectId) return err("Project not found.", 404);
    // The viewer's 10s change-poll is a HEAD that only reads the version
    // header. Serve it from a version-only select instead of reading and
    // filtering the whole doc every tick.
    if (req.method === "HEAD") {
      const meta = await prisma.cutProject.findFirst({
        where: { id: view.share.projectId, userId: view.share.userId },
        select: { version: true, updatedAt: true },
      });
      if (!meta) return err("Project not found.", 404);
      return new Response(null, {
        headers: {
          "x-cut-doc-version": String(meta.version),
          ...shareCacheHeaders(view.share, meta.updatedAt),
        },
      });
    }
    const row = await ownerProject(view.share);
    if (!row) return err("Project not found.", 404);
    return Response.json(filterDocForShare(row.doc as unknown as ProjectDoc, view.features), {
      headers: {
        "x-cut-doc-version": String(row.version),
        ...shareCacheHeaders(view.share, row.updatedAt),
      },
    });
  },

  async serveMedia(token: string, id: string, file: string, req: Request) {
    try {
      const view = await resolveShare(token, req);
      if (view instanceof Response) return view;
      if (id !== view.share.projectId) return err("Project not found.", 404);
      const fileName = decodeFileParam(file);
      const allowed = await allowedFileNames(view.share, view.features);
      if (!allowed.has(fileName)) return err("Media not found.", 404);
      return redirect(
        await sharedMediaUrl(projectMediaKey(view.share.userId, id, fileName)),
        shareRedirectHeaders(view.share, mediaRedirectTtl())
      );
    } catch (e) {
      return caught(e, "Bad request.", 400);
    }
  },

  async presignGetBatch(token: string, req: Request) {
    try {
      const view = await resolveShare(token, req);
      if (view instanceof Response) return view;
      const { items } = (await req.json()) as {
        items?: { projectId?: string; fileName?: string }[];
      };
      if (!Array.isArray(items)) return err("items is required.", 400);
      if (items.length > PRESIGN_GET_BATCH_MAX) return err("Too many items.", 400);
      const allowed = await allowedFileNames(view.share, view.features);
      const urls = await Promise.all(
        items
          .filter(
            (i) =>
              i.projectId === view.share.projectId &&
              typeof i.fileName === "string" &&
              allowed.has(i.fileName)
          )
          .map(async (i) => ({
            projectId: i.projectId!,
            fileName: i.fileName!,
            url: await sharedMediaUrl(
              projectMediaKey(view.share.userId, i.projectId!, i.fileName!)
            ),
          }))
      );
      return Response.json({ urls, expiresIn: mediaUrlLifetime() });
    } catch (e) {
      return caught(e, "Could not sign the media URLs.");
    }
  },

  async chats(token: string, id: string, req: Request) {
    const view = await resolveShare(token, req);
    if (view instanceof Response) return view;
    if (id !== view.share.projectId || !view.features.chat) return err("Not found.", 404);
    const rows = await prisma.cutChatThread.findMany({
      where: { userId: view.share.userId, projectId: id },
      orderBy: { updatedAt: "desc" },
      select: { data: true, updatedAt: true },
    });
    return Response.json(
      rows.map((r) => r.data),
      { headers: shareCacheHeaders(view.share, rows[0]?.updatedAt) }
    );
  },

  async preview(token: string, id: string, req: Request) {
    try {
      const view = await resolveShare(token, req);
      if (view instanceof Response) return view;
      if (id !== view.share.projectId) return err("Not found.", 404);
      const row = await ownerProject(view.share);
      if (!row?.previewKey) return new Response("Not found.", { status: 404 });
      return redirect(
        await sharedMediaUrl(row.previewKey),
        shareRedirectHeaders(view.share, mediaRedirectTtl())
      );
    } catch (e) {
      return caught(e, "Bad request.", 400);
    }
  },

};
