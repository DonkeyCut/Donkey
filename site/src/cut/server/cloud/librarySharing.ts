import { randomBytes } from "node:crypto";
import { z } from "zod";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { getGlobalSetting } from "@/lib/config/effective";
import {
  libraryShareTargetSchema, shareSettingsSchema,
  type LibraryShareTarget, type SharedLibraryPage,
} from "@/cut/lib/librarySharing";
import { libraryShareAccess, sharedFolderTrail } from "@/cut/server/cloud/libraryShareAccess";
import { assetView, templateView } from "@/cut/server/cloud/library";
import { mediaObjectUrl } from "@/cut/server/cloud/mediaCdn";

const privateHeaders = { "Cache-Control": "private, no-store", Vary: "Cookie" };
const err = (error: string, status: number) => Response.json({ error }, { status, headers: privateHeaders });
const json = (body: unknown) => Response.json(body, { headers: privateHeaders });
const tokenSchema = z.string().regex(/^[A-Za-z0-9_-]{32}$/);
const querySchema = z.object({
  folder: z.string().min(1).max(128).optional(),
  offset: z.coerce.number().int().min(0).max(1000000).default(0),
});

export function createLibrarySharing(
  db: Pick<typeof prisma, "cutFolder" | "cutLibraryAsset" | "cutLibraryShare" | "cutTemplate" | "cutMediaObject">,
  getSession: (headers: Headers) => Promise<{ user: { id: string; email: string; emailVerified: boolean } } | null>,
  getPageSize: () => Promise<number>,
  signMedia: typeof mediaObjectUrl = mediaObjectUrl,
) {
  async function ownedTarget(userId: string, target: LibraryShareTarget) {
    return target.kind === "folder"
      ? db.cutFolder.findFirst({ where: { id: target.id, userId, scope: "library" } })
      : db.cutLibraryAsset.findFirst({ where: { id: target.id, userId, deletedAt: null } });
  }

  const handlers = {
    async manage(req: Request, userId: string, kind: string, id: string) {
      const parsed = libraryShareTargetSchema.safeParse({ kind, id });
      if (!parsed.success) return err("Invalid share target.", 400);
      if (!(await ownedTarget(userId, parsed.data))) return err("Not found.", 404);
      const where = { userId_kind_targetId: { userId, kind, targetId: id } };
      if (req.method === "DELETE") {
        await db.cutLibraryShare.deleteMany({ where: { userId, kind, targetId: id } });
        return json({ ok: true });
      }
      if (req.method === "GET") {
        const row = await db.cutLibraryShare.findUnique({ where });
        return json({ share: row ? { id: row.id, ...shareSettingsSchema.parse(row) } : null });
      }
      const body = shareSettingsSchema.safeParse(await req.json().catch(() => null));
      if (!body.success) return err("Invalid sharing settings.", 400);
      const row = await db.cutLibraryShare.upsert({
        where,
        create: { id: randomBytes(24).toString("base64url"), userId, kind, targetId: id, ...body.data },
        update: body.data,
      });
      return json({ share: { id: row.id, ...body.data } });
    },

    async list(req: Request, token: string) {
      const resolved = await resolve(req, token);
      if (resolved instanceof Response) return resolved;
      const { share, target } = resolved;
      const parsed = querySchema.safeParse(Object.fromEntries(new URL(req.url).searchParams));
      if (!parsed.success) return err("Invalid folder page.", 400);
      const { folder, offset } = parsed.data;
      const pageSize = await getPageSize();
      const readFolder = (id: string) => db.cutFolder.findFirst({
        where: { id, userId: share.userId, scope: "library" },
        select: { id: true, name: true, parentId: true },
      });
      const trail = target.kind === "folder"
        ? await sharedFolderTrail(target.id, folder ?? target.id, readFolder)
        : [];
      if (!trail || (target.kind === "asset" && folder)) return err("Not found.", 404);
      const folderId = trail.at(-1)?.id;
      const [folders, assets, templates] = await Promise.all([
        folderId ? db.cutFolder.findMany({
          where: { userId: share.userId, scope: "library", parentId: folderId },
          select: { id: true, name: true }, orderBy: { id: "asc" }, skip: offset, take: pageSize + 1,
        }) : [],
        db.cutLibraryAsset.findMany({
          where: { userId: share.userId, deletedAt: null,
            ...(target.kind === "asset" ? { id: target.id } : { folderId }) },
          orderBy: { id: "asc" }, skip: offset, take: pageSize + 1,
        }),
        folderId ? db.cutTemplate.findMany({
          where: { userId: share.userId, doc: { path: ["folderId"], equals: folderId } },
          orderBy: { id: "asc" }, skip: offset, take: pageSize + 1,
        }) : [],
      ]);
      const objects = await db.cutMediaObject.findMany({
        where: { id: { in: assets.slice(0, pageSize).map((a) => a.mediaObjectId) },
          userId: share.userId, kind: "library", uploadState: "complete" },
        select: { id: true, fileName: true },
      });
      const byId = new Map(objects.map((o) => [o.id, o]));
      const publicAssets = assets.slice(0, pageSize).flatMap((a) => {
        const object = byId.get(a.mediaObjectId);
        if (!object) return [];
        const v = assetView(a, object);
        return [{ id: v.id, name: v.title || v.name, fileName: v.fileName, type: v.type, duration: v.duration,
          ...(v.width && v.height ? { width: v.width, height: v.height } : {}),
          ...(v.posterFile ? { hasPoster: true } : {}),
        }];
      });
      const body: SharedLibraryPage = {
        name: trail[0]?.name ?? publicAssets[0]?.name ?? "Shared asset",
        kind: target.kind, trail, folders: folders.slice(0, pageSize).map(({ id, name }) => ({ id, name })), assets: publicAssets,
        templates: templates.slice(0, pageSize).map((row) => {
          const t = templateView(row);
          return { id: t.id, name: t.name, files: t.media.map((m) => ({ name: m.name, fileName: m.fileName })) };
        }),
        next: [folders, assets, templates].some((rows) => rows.length > pageSize) ? offset + pageSize : null,
      };
      return json(body);
    },

    async media(req: Request, token: string, assetId: string) {
      const resolved = await resolve(req, token);
      if (resolved instanceof Response) return resolved;
      const { share, target } = resolved;
      if (!z.string().min(1).max(128).safeParse(assetId).success) return err("Not found.", 404);
      const query = z.object({
        template: z.string().min(1).max(128).optional(),
        file: z.string().min(1).max(512).optional(),
        download: z.enum(["1"]).optional(),
        poster: z.enum(["1"]).optional(),
      }).safeParse(Object.fromEntries(new URL(req.url).searchParams));
      if (!query.success) return err("Invalid media request.", 400);
      let folderId: string | null;
      let fileName: string;
      let mediaObjectId: string | undefined;
      if (query.data.template) {
        if (query.data.poster || target.kind !== "folder" || query.data.template !== assetId) return err("Not found.", 404);
        const row = await db.cutTemplate.findFirst({ where: { id: assetId, userId: share.userId } });
        if (!row) return err("Not found.", 404);
        const template = templateView(row);
        const media = template.media.find((m) => m.fileName === query.data.file);
        if (!media) return err("Not found.", 404);
        folderId = template.folderId ?? null;
        fileName = media.fileName;
      } else {
        if (target.kind === "asset" && target.id !== assetId) return err("Not found.", 404);
        const row = await db.cutLibraryAsset.findFirst({
          where: { id: assetId, userId: share.userId, deletedAt: null },
        });
        if (!row) return err("Not found.", 404);
        folderId = row.folderId;
        if (query.data.poster) {
          const posterFile = assetView(row, { fileName: "" }).posterFile;
          if (!posterFile) return err("Not found.", 404);
          fileName = posterFile;
        } else {
          mediaObjectId = row.mediaObjectId;
          fileName = "";
        }
      }
      if (target.kind === "folder") {
        if (!folderId || !(await sharedFolderTrail(target.id, folderId, (id) =>
          db.cutFolder.findFirst({ where: { id, userId: share.userId, scope: "library" },
            select: { id: true, name: true, parentId: true } })))) return err("Not found.", 404);
      }
      const object = await db.cutMediaObject.findFirst({
        where: { userId: share.userId, kind: "library", uploadState: "complete",
          ...(mediaObjectId ? { id: mediaObjectId } : { fileName }) },
      });
      if (!object) return err("Not found.", 404);
      return new Response(null, { status: 302, headers: {
        ...privateHeaders,
        Location: signMedia(object.r2Key, {
          version: String(object.updatedAt.getTime()),
          ...(query.data.download ? { downloadName: object.fileName } : {}),
        }),
      } });
    },
  };

  async function resolve(req: Request, token: string) {
    if (!tokenSchema.safeParse(token).success) return err("Not found.", 404);
    const share = await db.cutLibraryShare.findUnique({ where: { id: token } });
    if (!share) return err("Not found.", 404);
    const settings = shareSettingsSchema.safeParse(share);
    const target = libraryShareTargetSchema.safeParse({ kind: share.kind, id: share.targetId });
    if (!settings.success || !target.success) return err("Not found.", 404);
    const session = share.access === "public" ? null : await getSession(req.headers);
    const status = libraryShareAccess({ ...settings.data, userId: share.userId }, session?.user ?? null);
    if (status !== 200) return err(status === 401 ? "Sign in to view this share." : "You don't have access to this share.", status);
    if (!(await ownedTarget(share.userId, target.data))) return err("Not found.", 404);
    return { share, target: target.data };
  }

  return handlers;
}

export const librarySharing = createLibrarySharing(
  prisma,
  (headers) => auth.api.getSession({ headers }),
  async () => (await getGlobalSetting("librarySharing")).pageSize,
);
