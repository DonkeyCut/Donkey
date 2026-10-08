import { beforeEach, expect, mock, test } from "bun:test";
import { stubModule } from "@/lib/testing/stubModule";

// A browser render that lands with stems registers each file at its own size,
// and the account is charged their sum once. A released render takes only the
// files no row registered: a stems zip from an older export with the same name
// stays.
type Row = { id: string; kind: string; projectId: string; outName: string; state: string; spec: unknown };
let job: Row;
const sizes = new Map<string, number>();
const registered = new Set<string>();
const created: { r2Key: string; bytes: bigint }[] = [];
const deleted: string[] = [];
const added: number[] = [];
const tx = {
  cutMediaObject: {
    createMany: mock(async ({ data }: { data: { r2Key: string; bytes: bigint }[] }) => {
      created.push(...data);
      return { count: data.length };
    }),
  },
  cutRenderJob: { update: mock(async () => ({})) },
};
const prisma = {
  cutRenderJob: {
    findFirst: mock(async () => job),
    updateMany: mock(async () => ({ count: 1 })),
  },
  cutMediaObject: {
    findMany: mock(async ({ where }: { where: { r2Key: { in: string[] } } }) =>
      where.r2Key.in.filter((k) => registered.has(k)).map((r2Key) => ({ r2Key }))
    ),
  },
  $transaction: mock(async (fn: (t: typeof tx) => Promise<unknown>) => fn(tx)),
};
await stubModule<typeof import("@/lib/prisma")>("@/lib/prisma", import.meta.url, { prisma: prisma as never });
await stubModule<typeof import("./r2")>("./r2", import.meta.url, {
  head: (async (key: string) => (sizes.has(key) ? { bytes: sizes.get(key)!, mime: "", etag: "" } : null)) as never,
  del: (async (keys: string[]) => { deleted.push(...keys); }) as never,
  projectExportKey: ((userId: string, projectId: string, name: string) => `cut/${userId}/${projectId}/exports/${name}`) as never,
});
await stubModule<typeof import("./usage")>("./usage", import.meta.url, {
  quotaCheck: (async () => null) as never,
  addUsage: (async (_tx: unknown, _user: string, delta: number) => { added.push(delta); }) as never,
});
const { jobsCloud } = await import("./jobs");

const MB = 1024 * 1024;
const post = (body: unknown) => new Request("http://x", { method: "POST", body: JSON.stringify(body) });

beforeEach(() => {
  sizes.clear();
  registered.clear();
  created.length = 0;
  deleted.length = 0;
  added.length = 0;
});

test("a render with stems registers each file at its own size and charges the sum once", async () => {
  job = { id: "j", kind: "export", projectId: "p", outName: "Trip.mp4", state: "running", spec: { client: true, stems: true } };
  sizes.set("cut/u/p/exports/Trip.mp4", 50 * MB);
  sizes.set("cut/u/p/exports/Trip stems.zip", 400 * MB);
  const res = await jobsCloud.exportClientComplete("u", post({ jobId: "j" }));
  expect(res.status).toBe(200);
  expect(created.map((c) => [c.r2Key, Number(c.bytes)])).toEqual([
    ["cut/u/p/exports/Trip.mp4", 50 * MB],
    ["cut/u/p/exports/Trip stems.zip", 400 * MB],
  ]);
  expect(added).toEqual([450 * MB]);
});

test("a released plain render leaves a registered stems zip of the same name", async () => {
  job = { id: "j", kind: "export", projectId: "p", outName: "Trip.mp4", state: "running", spec: { client: true } };
  registered.add("cut/u/p/exports/Trip stems.zip");
  await jobsCloud.exportClientRelease("u", "j");
  expect(deleted).toEqual(["cut/u/p/exports/Trip.mp4"]);
});

test("a released plain render leaves the unregistered stems of an export still landing", async () => {
  // "Trip.mov" with stems has uploaded "Trip stems.zip" and not completed;
  // the plain "Trip.mp4" fails and gives its name back.
  job = { id: "j", kind: "export", projectId: "p", outName: "Trip.mp4", state: "running", spec: { client: true } };
  await jobsCloud.exportClientRelease("u", "j");
  expect(deleted).toEqual(["cut/u/p/exports/Trip.mp4"]);
});

test("a released render with stems takes its own unregistered stems", async () => {
  job = { id: "j", kind: "export", projectId: "p", outName: "Trip.mp4", state: "running", spec: { client: true, stems: true } };
  await jobsCloud.exportClientRelease("u", "j");
  expect(deleted).toEqual(["cut/u/p/exports/Trip.mp4", "cut/u/p/exports/Trip stems.zip"]);
});
