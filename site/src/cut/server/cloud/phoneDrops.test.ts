import { beforeEach, expect, mock, test } from "bun:test";

// One pass, one drop and one 20 MiB file the phone is sending.
const MIB = 1024 * 1024;
const file = {
  id: "f1",
  dropId: "d1",
  passId: "p1",
  userId: "u1",
  bytes: BigInt(20 * MIB),
  state: "sending",
  r2Key: "cut-phone/u1/d1/f1",
  uploadId: "up1",
  thumbKey: null as string | null,
};
let fileState = file.state;
let stored = 0;
const signed: [number, number][] = [];
const deleted: string[][] = [];

mock.module("@/lib/prisma", () => ({
  configureDatabasePool: () => {},
  prisma: {
    cutPhonePass: { findUnique: async () => ({ id: "p1", dropId: "d1" }) },
    cutPhoneDrop: { findUnique: async () => ({ id: "d1", userId: "u1", closedAt: null, aliveAt: new Date() }) },
    cutPhoneFile: {
      findFirst: async () => ({ ...file, state: fileState }),
      update: async (args: { data: { state?: string } }) => {
        fileState = args.data.state ?? fileState;
        return file;
      },
      updateMany: async () => ({ count: 1 }),
      findUniqueOrThrow: async () => ({ ...file, state: fileState }),
    },
  },
}));
const r2 = await import("./r2");
mock.module("./r2", () => ({
  ...r2,
  presignPart: async (_key: string, _upload: string, part: number, bytes: number) => {
    signed.push([part, bytes]);
    return `https://r2.example/${part}`;
  },
  completeMultipart: async () => {},
  head: async () => ({ bytes: stored, mime: "video/mp4", etag: "e" }),
  del: async (keys: string[]) => {
    deleted.push(keys);
  },
}));
const { phoneDropsOwner, phoneDropsPublic } = await import("./phoneDrops");
const { CUT_MEDIA_ORIGIN } = await import("@/cut/lib/hosts");

const PASS = "a".repeat(32);
const call = (body: unknown) =>
  new Request("https://donkeycut.com/api/cut-phone/files/f1/parts", { method: "POST", body: JSON.stringify(body) });

beforeEach(() => {
  fileState = "sending";
  signed.length = 0;
  deleted.length = 0;
});

test("each part URL is signed for exactly its part's bytes", async () => {
  const res = await phoneDropsPublic.parts(call({ pass: PASS, sent: 0, parts: [1, 2, 3] }), "f1");
  expect(res.status).toBe(200);
  expect(signed).toEqual([
    [1, 8 * MIB],
    [2, 8 * MIB],
    [3, 4 * MIB],
  ]);
});

test("a part past the file's end gets no URL", async () => {
  const res = await phoneDropsPublic.parts(call({ pass: PASS, sent: 0, parts: [4] }), "f1");
  expect(res.status).toBe(400);
  expect(signed).toEqual([]);
});

test("a joined file of the wrong size is failed and its bytes go", async () => {
  stored = 21 * MIB;
  const res = await phoneDropsPublic.complete(call({ pass: PASS }), "f1");
  expect(res.status).toBe(400);
  expect(fileState).toBe("failed");
  expect(deleted).toEqual([[file.r2Key]]);
});

test("a joined file of the declared size is staged", async () => {
  stored = 20 * MIB;
  const res = await phoneDropsPublic.complete(call({ pass: PASS }), "f1");
  expect(res.status).toBe(200);
  expect(fileState).toBe("staged");
  expect(deleted).toEqual([]);
});

test("a claimed file is read through the media edge, which answers the page's fetch", async () => {
  process.env.CUT_MEDIA_SIGNING_SECRET ??= "test-secret";
  const res = await phoneDropsOwner.claim("u1", "f1");
  const { url } = (await res.json()) as { url: string };
  expect(url.startsWith(`${CUT_MEDIA_ORIGIN}/cut-phone/u1/d1/f1?`)).toBe(true);
});
