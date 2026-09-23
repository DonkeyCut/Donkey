import { afterAll, beforeEach, expect, mock, test } from "bun:test";
import { stubModule } from "@/lib/testing/stubModule";

// The commands module reaches the database through the shared client; this
// stand-in keeps job rows in memory and answers the handful of calls the
// queue, claim, expiry and settle paths make.
type Row = {
  id: string; userId: string; projectId: string | null; kind: string; state: string;
  spec: Record<string, unknown>; result: unknown; error: string | null; progress: number;
  claimedAt: Date | null; createdAt: Date; updatedAt: Date;
};
const rows: Row[] = [];
const project = { id: "p", userId: "u", version: 4, doc: { name: "Cut" } };
const woken = { count: 0 };
const matches = (row: Row, where: Record<string, unknown>) =>
  Object.entries(where).every(([k, v]) => {
    const got = (row as Record<string, unknown>)[k];
    if (v && typeof v === "object" && !(v instanceof Date)) {
      const op = v as { in?: unknown[]; not?: unknown; lt?: Date };
      if (op.in) return op.in.includes(got);
      if ("not" in op) return got !== op.not;
      if (op.lt) return (got as Date).getTime() < op.lt.getTime();
    }
    return got === v;
  });
const prisma = {
  cutRenderJob: {
    findFirst: mock(async ({ where }: { where: Record<string, unknown> }) => rows.find((r) => matches(r, where)) ?? null),
    findMany: mock(async ({ where }: { where: Record<string, unknown> }) => rows.filter((r) => matches(r, where))),
    updateMany: mock(async ({ where, data }: { where: Record<string, unknown>; data: Partial<Row> }) => {
      const hit = rows.filter((r) => matches(r, where));
      for (const r of hit) Object.assign(r, data, { updatedAt: new Date() });
      return { count: hit.length };
    }),
    create: mock(async ({ data }: { data: Partial<Row> }) => {
      const row: Row = { id: `j${rows.length + 1}`, userId: "u", projectId: "p", kind: "commands", state: "queued", spec: {}, result: null, error: null, progress: 0, claimedAt: null, createdAt: new Date(), updatedAt: new Date(), ...data } as Row;
      rows.push(row);
      return row;
    }),
    delete: mock(async ({ where }: { where: { id: string } }) => {
      const at = rows.findIndex((r) => r.id === where.id);
      if (at >= 0) rows.splice(at, 1);
      return {};
    }),
    count: mock(async () => 0),
  },
  cutProject: {
    findFirst: mock(async ({ where }: { where: { id: string } }) => (where.id === project.id ? { ...project } : null)),
  },
  // The account is a super user, so the live-job cap never applies.
  user: { findUnique: mock(async () => ({ superUser: true })) },
  settingOverride: { findUnique: mock(async () => null) },
};
await stubModule<typeof import("@/lib/prisma")>("@/lib/prisma", import.meta.url, { prisma: prisma as never });
// The wake is a POST to the worker; count those instead of the network.
process.env.CUT_RENDER_WAKE_SECRET = "test-wake";
const realFetch = globalThis.fetch;
globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
  if (String(url).endsWith("/wake") && init?.method === "POST") { woken.count++; return new Response("ok"); }
  return realFetch(url, init);
}) as typeof fetch;
const { claimEditorBatch, CLAIM_QUIET_MS, heartbeatEditorBatch, NO_CARD_OPEN, queueCommands, settleEditorBatch, waitForJob } = await import("./commands");
afterAll(() => { globalThis.fetch = realFetch; });
beforeEach(() => { rows.splice(0); woken.count = 0; });

test("batches queue behind each other for the card without waking the worker, and the card claims them oldest first", async () => {
  expect(await queueCommands("u", "p", { commands: [{ name: "set_aspect", input: { aspect: "9:16" } }], label: "Frame" })).toEqual({ id: "j1" });
  expect(await queueCommands("u", "p", { commands: [{ name: "add_title", input: {} }] })).toEqual({ id: "j2" });
  expect(woken.count).toBe(0);
  const claimed = await claimEditorBatch("u", "p");
  expect(claimed).toEqual({ id: "j1", spec: { commands: [{ name: "set_aspect", input: { aspect: "9:16" } }], label: "Frame" } });
  expect(rows[0].state).toBe("running");
  expect((await claimEditorBatch("u", "p"))?.id).toBe("j2");
  expect(await claimEditorBatch("u", "p")).toBeNull();
});

test("a batch contends with a chat turn on the same project", async () => {
  rows.push({ id: "turn", userId: "u", projectId: "p", kind: "agent_turn", state: "running", spec: {}, result: null, error: null, progress: 0, claimedAt: new Date(), createdAt: new Date(Date.now() - 1000), updatedAt: new Date() });
  const refused = await queueCommands("u", "p", { commands: [{ name: "set_aspect", input: {} }] });
  expect(refused instanceof Response && refused.status).toBe(409);
  expect(rows.map((r) => r.id)).toEqual(["turn"]);
});

test("a batch no card claims in time is dismissed with the answer the tool gives", async () => {
  const queued = await queueCommands("u", "p", { commands: [{ name: "undo", input: {} }] });
  const id = (queued as { id: string }).id;
  rows[0].createdAt = new Date(Date.now() - 5000);
  const row = await waitForJob("u", id, 50, { editorClaimMs: 1000 });
  expect(row?.state).toBe("dismissed");
  expect(row?.error).toBe(NO_CARD_OPEN);
  expect(woken.count).toBe(0);
  expect(await claimEditorBatch("u", "p")).toBeNull();
});

test("a claimed batch whose editor stops beating ends in error, and a late report changes nothing", async () => {
  await queueCommands("u", "p", { commands: [{ name: "set_aspect", input: {} }] });
  await claimEditorBatch("u", "p");
  expect(await heartbeatEditorBatch("u", "j1", 0.5)).toBe(true);
  expect(rows[0].progress).toBe(0.5);
  rows[0].updatedAt = new Date(Date.now() - CLAIM_QUIET_MS - 1);
  const row = await waitForJob("u", "j1", 50);
  expect(row?.state).toBe("error");
  expect(await heartbeatEditorBatch("u", "j1", null)).toBe(false);
  expect(await settleEditorBatch("u", "j1", { ok: true, results: [], changed: true, docVersion: "5" })).toBe(false);
  expect(rows[0].state).toBe("error");
  // The next queue on the project clears any other quiet batch the same way.
  rows.push({ ...rows[0], id: "j9", state: "running", updatedAt: new Date(Date.now() - CLAIM_QUIET_MS - 1) });
  await queueCommands("u", "p", { commands: [{ name: "set_aspect", input: {} }] });
  expect(rows.find((r) => r.id === "j9")?.state).toBe("error");
});

test("the editor's report settles the batch", async () => {
  await queueCommands("u", "p", { commands: [{ name: "set_aspect", input: {} }], label: "Frame" });
  await claimEditorBatch("u", "p");
  expect(await settleEditorBatch("u", "j1", { ok: true, results: [{ name: "set_aspect", ok: true, output: {} }], changed: true, docVersion: "5" })).toBe(true);
  expect(rows[0].state).toBe("done");
  expect(rows[0].result).toEqual({ results: [{ name: "set_aspect", ok: true, output: {} }], changed: true, docVersion: "5" });
  expect(await settleEditorBatch("u", "j1", { ok: false, error: "late" })).toBe(false);

  await queueCommands("u", "p", { commands: [{ name: "get_state", input: {} }], readOnly: true });
  await claimEditorBatch("u", "p");
  expect(await settleEditorBatch("u", "j2", { ok: false, error: "The editor could not run the batch." })).toBe(true);
  expect(rows[1]).toMatchObject({ state: "error", error: "The editor could not run the batch." });
});
