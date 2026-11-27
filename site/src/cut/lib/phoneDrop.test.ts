import { afterAll, expect, mock, test } from "bun:test";

// The cloud routes answer from a script: one staged file in the inbox, a claim
// that hands back its read URL, and a record of every settle the page posts.
const posted: string[] = [];
const staged = {
  id: "f1",
  dropId: "d1",
  name: "clip.mp4",
  mime: "video/mp4",
  bytes: 4,
  target: { kind: "project", residency: "cloud", projectId: "p1", folderId: null },
};
let inboxReads = 0;
const cloud = await import("@/cut/lib/backend/cloud");
mock.module("@/cut/lib/backend/cloud", () => ({
  ...cloud,
  cloudRequest: async (path: string) => {
    posted.push(path);
    if (path.endsWith("/inbox")) {
      inboxReads++;
      return Response.json({ files: inboxReads === 1 ? [staged] : [], sending: [] });
    }
    if (path.endsWith("/claim")) {
      return Response.json({ url: "https://r2.example/staged" });
    }
    return Response.json({ ok: true });
  },
}));

const realFetch = globalThis.fetch;
globalThis.fetch = (async () => new Response(new Uint8Array(4))) as unknown as typeof fetch;
afterAll(() => {
  globalThis.fetch = realFetch;
});

const { landProjectFiles } = await import("./phoneDrop");

/** Run one inbox pass with `outcome` from the lander and answer what it
 * settled. Opening the editor's landing reads the inbox. */
async function settleWith(outcome: "landed" | "refused" | "again") {
  posted.length = 0;
  inboxReads = 0;
  const stop = landProjectFiles("p1", async () => outcome, () => {});
  for (let i = 0; i < 50 && !posted.some((p) => /\/(release|landed|failed)$/.test(p)); i++) {
    await new Promise((r) => setTimeout(r, 1));
  }
  // Let the pass finish before the next one opens.
  await new Promise((r) => setTimeout(r, 5));
  stop();
  return posted.filter((p) => p.startsWith("/api/cut-cloud/phone/files/")).map((p) => p.split("/").pop());
}

test("a file that is not in its place yet keeps its staged copy", async () => {
  expect(await settleWith("again")).toEqual(["claim", "release"]);
});

test("a landed file lets its staged copy go", async () => {
  expect(await settleWith("landed")).toEqual(["claim", "landed"]);
});

test("a refused file settles as failed", async () => {
  expect(await settleWith("refused")).toEqual(["claim", "failed"]);
});
