import { describe, expect, mock, test } from "bun:test";
import { prisma } from "@/lib/prisma";
import { libraryShareAccess, sharedFolderTrail } from "@/cut/server/cloud/libraryShareAccess";
import { createLibrarySharing } from "@/cut/server/cloud/librarySharing";
import { shareSettingsSchema } from "@/cut/lib/librarySharing";

const token = "abcdefghijklmnopqrstuvwx12345678";
const now = new Date("2026-01-01");
const share = { id: token, userId: "owner", kind: "folder", targetId: "root", access: "public", emails: [], createdAt: now, updatedAt: now };
const folder = (id: string, parentId: string | null = null) => ({ id, name: id, parentId, userId: "owner", scope: "library", createdAt: now, updatedAt: now });
const asset = { id: "asset", userId: "owner", folderId: "child", mediaObjectId: "object", meta: { name: "Sound.mp3", type: "audio" }, deletedAt: null, createdAt: now, updatedAt: now };
const request = (method = "GET", body?: unknown) => new Request(`https://donkeycut.com/api/cut-shared/library/${token}`, { method, ...(body ? { body: JSON.stringify(body), headers: { "Content-Type": "application/json" } } : {}) });
function harness() {
  const rows = [folder("root"), folder("child", "root"), folder("sibling")];
  const db = {
    cutLibraryShare: {
      findUnique: mock(async () => share as typeof share | null),
      upsert: mock(async (args: unknown) => { void args; return share; }),
      deleteMany: mock(async (args: unknown) => { void args; return { count: 1 }; }),
    },
    cutFolder: {
      findFirst: mock(async (args: { where: { id: string; userId: string; scope: string } }) =>
        rows.find((row) => row.id === args.where.id && row.userId === args.where.userId && row.scope === args.where.scope) ?? null),
      findMany: mock(async (args: unknown) => { void args; return [folder("child", "root")]; }),
    },
    cutLibraryAsset: {
      findFirst: mock(async (args: unknown) => { void args; return asset as typeof asset | null; }),
      findMany: mock(async (args: unknown) => { void args; return [asset]; }),
    },
    cutTemplate: { findMany: mock(async () => []), findFirst: mock(async () => null) },
    cutMediaObject: {
      findFirst: mock(async (args: unknown) => { void args; return ({ id: "object", fileName: "sound.mp3", r2Key: "cut/owner/library/sound.mp3", updatedAt: now }); }),
      findMany: mock(async () => [{ id: "object", fileName: "sound.mp3" }]),
    },
  };
  const session = mock(async () => null);
  const sign = mock((key: string, opts?: { version?: string; downloadName?: string }) => {
    void opts;
    return `https://media.test/${key}`;
  });
  const api = createLibrarySharing(db as unknown as typeof prisma, session, async () => 2, sign);
  return { api, db, session, sign };
}

describe("library sharing", () => {
  test("access requires public sharing, ownership, or a verified invited email", () => {
    const settings = { userId: "owner", access: "restricted" as const, emails: ["friend@example.com"] };
    expect(libraryShareAccess(settings, null)).toBe(401);
    expect(libraryShareAccess({ ...settings, access: "public" }, null)).toBe(200);
    expect(libraryShareAccess(settings, { id: "owner", email: "owner@example.com", emailVerified: false })).toBe(200);
    expect(libraryShareAccess(settings, { id: "friend", email: "FRIEND@example.com", emailVerified: true })).toBe(200);
    expect(libraryShareAccess(settings, { id: "friend", email: "friend@example.com", emailVerified: false })).toBe(403);
    expect(libraryShareAccess(settings, { id: "stranger", email: "stranger@example.com", emailVerified: true })).toBe(403);
    expect(shareSettingsSchema.parse({ access: "restricted", emails: [" Friend@example.com ", "friend@example.com"] }).emails).toEqual(["friend@example.com"]);
    expect(shareSettingsSchema.safeParse({ access: "public", emails: ["bad"] }).success).toBe(false);
    expect(shareSettingsSchema.safeParse({ access: "typo", emails: [] }).success).toBe(false);
  });
  test("ancestry accepts descendants and rejects siblings, missing parents, and cycles", async () => {
    const rows = [folder("root"), folder("child", "root"), folder("grandchild", "child"), folder("sibling"), folder("cycle", "cycle")];
    const read = async (id: string) => rows.find((row) => row.id === id) ?? null;
    expect(await sharedFolderTrail("root", "grandchild", read)).toEqual([{ id: "root", name: "root" }, { id: "child", name: "child" }, { id: "grandchild", name: "grandchild" }]);
    for (const id of ["sibling", "missing", "cycle"]) expect(await sharedFolderTrail("root", id, read)).toBeNull();
  });
  test("revoked and malformed links cannot read media", async () => {
    const { api, db } = harness();
    const lookup = db.cutLibraryShare.findUnique.mockResolvedValue(null);
    expect((await api.media(request(), "bad", "asset")).status).toBe(404);
    expect(lookup).not.toHaveBeenCalled();
    expect((await api.media(request(), token, "asset")).status).toBe(404);
  });
  test("restricted reads stop before content lookup without a session", async () => {
    const { api, db } = harness();
    db.cutLibraryShare.findUnique.mockResolvedValue({ ...share, access: "restricted" });
    const contents = db.cutLibraryAsset.findFirst;
    const response = await api.media(request(), token, "asset");
    expect(response.status).toBe(401);
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    expect(contents).not.toHaveBeenCalled();
  });
  test("an asset moved outside the tree loses folder-link access", async () => {
    const { api, db } = harness();
    db.cutLibraryAsset.findFirst.mockResolvedValue({ ...asset, folderId: "sibling" });
    const media = db.cutMediaObject.findFirst;
    expect((await api.media(request(), token, "asset")).status).toBe(404);
    expect(media).not.toHaveBeenCalled();
  });
  test("a standalone link cannot access another asset", async () => {
    const { api, db } = harness();
    db.cutLibraryShare.findUnique.mockResolvedValue({ ...share, kind: "asset", targetId: "asset" });
    expect((await api.media(request(), token, "other-asset")).status).toBe(404);
  });
  test("share changes require target ownership and validate settings", async () => {
    const { api, db } = harness();
    const write = db.cutLibraryShare.upsert;
    expect((await api.manage(request("PUT", { access: "public", emails: [] }), "stranger", "folder", "root")).status).toBe(404);
    expect((await api.manage(request("PUT", { access: "bad", emails: [] }), "owner", "folder", "root")).status).toBe(400);
    expect(write).not.toHaveBeenCalled();
    expect((await api.manage(request("PUT", { access: "restricted", emails: ["Friend@example.com"] }), "owner", "folder", "root")).status).toBe(200);
    const args = write.mock.calls[0][0] as Parameters<typeof prisma.cutLibraryShare.upsert>[0];
    expect(args.where).toEqual({ userId_kind_targetId: { userId: "owner", kind: "folder", targetId: "root" } });
    expect(/^[A-Za-z0-9_-]{32}$/.test(args.create.id)).toBe(true);
    expect(args.update.emails).toEqual(["friend@example.com"]);
    const remove = db.cutLibraryShare.deleteMany;
    expect((await api.manage(request("DELETE"), "owner", "folder", "root")).status).toBe(200);
    expect(remove.mock.calls[0][0]).toEqual({ where: { userId: "owner", kind: "folder", targetId: "root" } });
  });
  test("folder listings expose only their scoped page and omit owner metadata", async () => {
    const { api, db } = harness();
    const response = await api.list(request(), token);
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.name).toBe("root");
    expect(body.assets).toEqual([{ id: "asset", name: "Sound.mp3", fileName: "sound.mp3", type: "audio", duration: 0 }]);
    expect(db.cutLibraryAsset.findMany.mock.calls[0][0]).toMatchObject({ where: { userId: "owner", deletedAt: null, folderId: "root" }, take: 3 });
    expect(JSON.stringify(body)).not.toContain("owner");
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
  });
  test("deleted targets and sibling folder requests do not produce a listing", async () => {
    const { api, db } = harness();
    expect((await api.list(new Request(`${request().url}?folder=sibling`), token)).status).toBe(404);
    db.cutFolder.findFirst.mockResolvedValue(null);
    expect((await api.list(request(), token)).status).toBe(404);
    expect(db.cutLibraryAsset.findMany).not.toHaveBeenCalled();
  });

  test("authorized media resolves the owner's complete object and preserves the download filename", async () => {
    const { api, db, sign } = harness();
    const response = await api.media(new Request(`${request().url}?download=1`), token, "asset");
    expect(response.status).toBe(302);
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    expect(sign.mock.calls[0]).toEqual(["cut/owner/library/sound.mp3", { version: String(now.getTime()), downloadName: "sound.mp3" }]);
    expect(db.cutMediaObject.findFirst.mock.calls[0][0]).toEqual({ where: { userId: "owner", kind: "library", uploadState: "complete", id: "object" } });
    db.cutLibraryAsset.findFirst.mockResolvedValue(null);
    expect((await api.media(request(), token, "asset")).status).toBe(404);
  });

});
