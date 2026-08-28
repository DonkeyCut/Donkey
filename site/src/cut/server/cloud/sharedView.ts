// Viewer-side reads of a shared cloud project. Every handler resolves the
// share token first, then reads the OWNER's rows and presigns the owner's R2
// keys — the viewer's session (if any) only ever gates access. The server is
// the content boundary: the filtered doc and the media allowlist are what
// decide which bytes a viewer can reach; the client's tab hiding is
// presentation only. Copying a share lives in copyQueue.ts.
import { uploadedFontId, type ProjectDoc, type StoredAsset } from "@/cut/lib/types";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { readLadder } from "./ladderStore";
import { mediaObjectUrl, mediaTreeUrl, mediaUrlLifetime } from "./mediaCdn";
import { projectHlsPrefix, projectMediaKey } from "./r2";
import { normalizeEmails, normalizeFeatures, type ShareFeatures } from "./share";
import { shareCacheHeaders, shareRedirectHeaders } from "./shareCache";
import { caught, decodeFileParam, err, redirect } from "./util";

const PRESIGN_GET_BATCH_MAX = 500;
/** How long a media redirect may be reused. Tokens are minted on window
 * boundaries, so the redirect is reusable until the window turns over; this
 * keeps it well inside that. */
const MEDIA_REDIRECT_TTL = 15 * 60;

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

/** Cache versions for the owner's media, by file name. A media URL without
 * one is a URL that never changes when its bytes do, and both the edge and
 * the browser's chunk cache key on it — so a viewer who returns after the
 * owner re-imports the same name would play the old file. */
async function mediaVersions(share: ShareRow, fileNames: string[]): Promise<Map<string, string>> {
  if (!fileNames.length) return new Map();
  const rows = await prisma.cutMediaObject.findMany({
    where: { userId: share.userId, projectId: share.projectId, kind: "media", fileName: { in: fileNames } },
    select: { fileName: true, updatedAt: true },
  });
  return new Map(rows.map((r) => [r.fileName, String(r.updatedAt.getTime())]));
}

/** What the share offers a viewer. Chat drops out when the owner's project has
 * no threads: there is nothing to open, so the viewer gets no chat button and
 * no panel rather than an empty conversation. */
async function offeredFeatures(view: ShareView): Promise<ShareFeatures> {
  if (!view.features.chat) return view.features;
  const threads = await prisma.cutChatThread.count({
    where: { userId: view.share.userId, projectId: view.share.projectId },
  });
  return threads > 0 ? view.features : { ...view.features, chat: false };
}

/** The asset set a viewer may see: everything playback needs, plus each
 * optional surface's assets when that surface is shared. Playback references
 * more than the clips' own sources: a removal's baked matte and fill image,
 * sticker overlays' pictures, and uploaded fonts on text overlays and shared
 * captions all draw into the frame, so each rides along with the clip that
 * uses it. Untagged assets belong to the Media panel; origin-tagged ones to
 * the generate panels; chat-tagged ones to chat. The Library is never
 * shared. */
function allowedAssets(doc: ProjectDoc, features: ShareFeatures): StoredAsset[] {
  const assets = Array.isArray(doc.assets) ? doc.assets : [];
  const clips = Array.isArray(doc.clips) ? doc.clips : [];
  const referenced = new Set<string>([
    ...clips.map((c) => c.assetId),
    ...(Array.isArray(doc.audioClips) ? doc.audioClips : []).map((c) => c.assetId),
  ]);
  for (const c of clips) {
    if (c.removal?.matte) referenced.add(c.removal.matte.assetId);
    if (c.removal?.backdrop?.assetId) referenced.add(c.removal.backdrop.assetId);
  }
  const fonts = new Set<string>();
  for (const o of Array.isArray(doc.overlays) ? doc.overlays : []) {
    if (o.kind === "sticker" && o.assetId) referenced.add(o.assetId);
    if (o.kind === "text") fonts.add(o.font);
  }
  if (features.subtitles && doc.subtitles?.font) fonts.add(doc.subtitles.font);
  return assets.filter((a) => {
    if (referenced.has(a.id) || fonts.has(uploadedFontId(a.id))) return true;
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
        features: await offeredFeatures(view),
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
      const version = (await mediaVersions(view.share, [fileName])).get(fileName);
      return redirect(
        mediaObjectUrl(projectMediaKey(view.share.userId, id, fileName), { version }),
        shareRedirectHeaders(view.share, MEDIA_REDIRECT_TTL)
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
      const wanted = items.filter(
        (i) =>
          i.projectId === view.share.projectId &&
          typeof i.fileName === "string" &&
          allowed.has(i.fileName)
      );
      const versions = await mediaVersions(
        view.share,
        wanted.map((i) => i.fileName!)
      );
      const urls = wanted.map((i) => ({
        projectId: i.projectId!,
        fileName: i.fileName!,
        url: mediaObjectUrl(projectMediaKey(view.share.userId, i.projectId!, i.fileName!), {
          version: versions.get(i.fileName!),
        }),
      }));
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

  /**
   * The share's streaming manifest: a tree-token URL for the published HLS
   * master, or 404 while no ladder exists yet.
   *
   * The token is sized to the cut's own duration, so a viewer who starts a long
   * project and watches it straight through never has playback die on an
   * expired segment. It is also the revocation window for those bytes, which is
   * why it tracks the content rather than being long by default.
   */
  async stream(token: string, id: string, req: Request) {
    try {
      const view = await resolveShare(token, req);
      if (view instanceof Response) return view;
      if (id !== view.share.projectId) return err("Not found.", 404);
      const ladder = await readLadder(id);
      // The record names the owner it was rendered for; a share whose project
      // changed hands is not served someone else's tree.
      const current = ladder?.userId === view.share.userId ? ladder.current : undefined;
      if (!current) return err("No stream yet.", 404);
      // The render is only as filtered as the share it was built for. If the
      // owner has since turned Subtitles off, the existing ladder still has cue
      // text in its pixels and there is nothing left to strip — so it is
      // withheld entirely, which reads to the viewer as a stream still being
      // prepared and is exactly what the next render fixes.
      if (current.burnedSubtitles && !view.features.subtitles) {
        return err("No stream yet.", 404);
      }
      const url = mediaTreeUrl(
        projectHlsPrefix(view.share.userId, id, current.version),
        "master.m3u8",
        { holdSeconds: Math.ceil(current.duration * 1.5) }
      );
      // Deliberately uncached, unlike the rest of a share's reads. A viewer who
      // opens a link mid-render polls this until the ladder appears, so an
      // edge-cached 404 would keep answering "not yet" after it had. The
      // response is a few bytes; the segments behind it are what caching is
      // for.
      return Response.json(
        { url, duration: current.duration },
        { headers: { "Cache-Control": "private, no-store" } }
      );
    } catch (e) {
      // 5xx, not 400: a store that is misconfigured or briefly unreachable is
      // the server's problem, and the viewer's poll should keep asking rather
      // than read it as "this share has no stream".
      return caught(e, "Could not read the stream.", 500);
    }
  },

  async preview(token: string, id: string, req: Request) {
    try {
      const view = await resolveShare(token, req);
      if (view instanceof Response) return view;
      if (id !== view.share.projectId) return err("Not found.", 404);
      const row = await ownerProject(view.share);
      if (!row?.previewKey) return new Response("Not found.", { status: 404 });
      // The proxy is rendered from the owner's own doc, captions and all, so it
      // crosses the same boundary the ladder does: a share that hides Subtitles
      // must not be handed a render with the cue text burned into it.
      const doc = row.doc as unknown as ProjectDoc | null;
      if (doc?.subtitles?.showOnVideo && !view.features.subtitles) {
        return new Response("Not found.", { status: 404 });
      }
      return redirect(
        mediaObjectUrl(row.previewKey, { version: String(row.updatedAt.getTime()) }),
        shareRedirectHeaders(view.share, MEDIA_REDIRECT_TTL)
      );
    } catch (e) {
      return caught(e, "Bad request.", 400);
    }
  },

};
