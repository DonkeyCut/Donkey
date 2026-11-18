import { expect, mock, test } from "bun:test";
import type { prisma } from "@/lib/prisma";
import { backfillCards, CARD_BACKFILL_MAX } from "./cardBackfill";

type Job = { projectId: string; state: string; spec: unknown };

type Drawn = { projectId: string; _max: { createdAt: Date } };

function harness(jobs: Job[] = [], drawn: Drawn[] = []) {
  const render = mock(async (userId: string, projectId: string) => {
    void userId;
    return { id: `job-${projectId}` } as unknown;
  });
  const findMany = mock(async (args: unknown) => {
    void args;
    return jobs;
  });
  const groupBy = mock(async (args: unknown) => {
    void args;
    return drawn;
  });
  const db = {
    cutRenderJob: { findMany, groupBy },
  } as unknown as typeof prisma;
  return { render, findMany, deps: { db, render: render as never } };
}

const card = (
  id: string,
  extra: Partial<{
    version: number;
    previewKey: string | null;
    duration: number;
    updatedAt: number;
  }> = {},
) => ({
  id,
  version: 1,
  previewKey: null,
  duration: 10,
  updatedAt: SAVED,
  ...extra,
});

// When every test project was last saved.
const SAVED = Date.UTC(2026, 10, 18, 6, 8);

test("a listed project with no card has one rendered from its saved doc", async () => {
  const h = harness(
    [],
    [{ projectId: "b", _max: { createdAt: new Date(SAVED + 1) } }],
  );
  await backfillCards(
    "owner",
    [card("a"), card("b", { previewKey: "key" })],
    h.deps,
  );
  expect(h.render.mock.calls).toEqual([["owner", "a"]]);
});

test("an empty project has nothing to render", async () => {
  const h = harness();
  await backfillCards("owner", [card("a", { duration: 0 })], h.deps);
  expect(h.render).not.toHaveBeenCalled();
  expect(h.findMany).not.toHaveBeenCalled();
});

test("a revision that already had a card render, even a failed one, is not queued again", async () => {
  const h = harness([
    { projectId: "failed", state: "error", spec: { revision: "cloud:3" } },
    { projectId: "stale", state: "error", spec: { revision: "cloud:2" } },
  ]);
  await backfillCards(
    "owner",
    [card("failed", { version: 3 }), card("stale", { version: 3 })],
    h.deps,
  );
  expect(h.render.mock.calls).toEqual([["owner", "stale"]]);
});

test("a card the editor is already rendering is left to it", async () => {
  const h = harness([
    { projectId: "a", state: "queued", spec: { revision: "tab:9" } },
  ]);
  await backfillCards("owner", [card("a")], h.deps);
  expect(h.render).not.toHaveBeenCalled();
});

test("one listing queues a bounded number of cards, newest first", async () => {
  const h = harness();
  const rows = Array.from({ length: CARD_BACKFILL_MAX + 3 }, (_, i) =>
    card(`p${i}`),
  );
  await backfillCards("owner", rows, h.deps);
  expect(h.render.mock.calls.map(([, id]) => id)).toEqual(
    rows.slice(0, CARD_BACKFILL_MAX).map((r) => r.id),
  );
});

test("one project's failure does not stop the rest", async () => {
  const h = harness();
  h.render.mockImplementation(async (_userId, projectId) => {
    if (projectId === "a") {
      throw new Error("boom");
    }
    return { id: `job-${projectId}` };
  });
  await backfillCards("owner", [card("a"), card("b")], h.deps);
  expect(h.render.mock.calls.map(([, id]) => id)).toEqual(["a", "b"]);
});

test("a card drawn before the project's last save is drawn again", async () => {
  const h = harness(
    [],
    [
      { projectId: "old", _max: { createdAt: new Date(SAVED - 60_000) } },
      { projectId: "new", _max: { createdAt: new Date(SAVED + 60_000) } },
    ],
  );
  await backfillCards(
    "owner",
    [card("old", { previewKey: "k1" }), card("new", { previewKey: "k2" })],
    h.deps,
  );
  expect(h.render.mock.calls).toEqual([["owner", "old"]]);
});
