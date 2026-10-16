import { describe, expect, test } from "bun:test";

import { stubModule } from "@/lib/testing/stubModule";

// The project's media rows, as the cases leave them, and every row the handler
// creates.
let rows: { fileName: string; bytes: bigint; uploadState: string; r2Key: string }[] = [];
const created: { fileName: string; uploadState: string }[] = [];

await stubModule("@/lib/prisma", import.meta.url, {
  prisma: {
    cutMediaObject: {
      findFirst: async ({ where }: { where: { fileName: string } }) => rows.find((r) => r.fileName === where.fileName) ?? null,
      create: async ({ data }: { data: { fileName: string; uploadState: string } }) => {
        created.push(data);
        return data;
      },
    },
  },
} as never);
await stubModule("./projects", import.meta.url, {
  getProject: async () => ({ id: "p1" }),
  takenMediaNames: async () => new Set(rows.map((r) => r.fileName)),
} as never);
await stubModule("./r2", import.meta.url, { presignPut: async () => "https://put" } as never);
await stubModule("./usage", import.meta.url, { quotaCheck: async () => null } as never);
const { mediaCloud } = await import("./media");

/** Ask for a fresh URL for a claim the browser still holds the bytes of. */
const resume = async (fileName: string, bytes: number) => {
  const req = new Request("https://donkeycut.com/api/cut-cloud/projects/p1/media/presign", {
    method: "POST",
    body: JSON.stringify({ fileName, bytes, mime: "video/mp4", resume: true }),
  });
  return (await (await mediaCloud.presign("u1", "p1", req)).json()) as { fileName: string; url?: string };
};

describe("resuming an upload", () => {
  test("re-claims the same name when the sweep dropped the stale claim", async () => {
    rows = [];
    created.length = 0;

    const answer = await resume("take.mp4", 100);

    expect(answer.fileName).toBe("take.mp4");
    expect(answer.url).toBe("https://put");
    expect(created).toMatchObject([{ fileName: "take.mp4", uploadState: "pending" }]);
  });

  test("re-signs a claim that is still there", async () => {
    rows = [{ fileName: "take.mp4", bytes: BigInt(100), uploadState: "pending", r2Key: "cut/u1/projects/p1/media/take.mp4" }];
    created.length = 0;

    const answer = await resume("take.mp4", 100);

    expect(answer.fileName).toBe("take.mp4");
    expect(created).toEqual([]);
  });
});
