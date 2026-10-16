import { beforeEach, describe, expect, test } from "bun:test";

import { sweepGoneProjectThreads, useThreadStore, type ThreadStore } from "./chatThreads";
import { listingSweeper } from "./threadSweep";

// Bun's test runtime has no localStorage; the chat module reads it per call.
const local = new Map<string, string>();
beforeEach(() => {
  local.clear();
  (globalThis as { localStorage?: unknown }).localStorage = {
    getItem: (k: string) => local.get(k) ?? null,
    setItem: (k: string, v: string) => void local.set(k, v),
    removeItem: (k: string) => void local.delete(k),
    get length() { return local.size; },
    key: (i: number) => [...local.keys()][i] ?? null,
  };
});

function heldThreads(...projectIds: string[]) {
  const lists = new Map<string, unknown[]>(projectIds.map((id) => [id, [{ id: `t-${id}` }]]));
  const store: ThreadStore = {
    read: async (projectId) => lists.get(projectId),
    write: async (projectId, list) => void lists.set(projectId, list),
    remove: async (projectId) => void lists.delete(projectId),
    projects: async () => [...lists.keys()],
    readQueues: async () => undefined,
    writeQueues: async () => {},
  };
  return { lists, store };
}

describe("the listing sweep", () => {
  test("a listing that arrives before the session confirms the account marks and clears nothing", async () => {
    const { lists, store } = heldThreads("listed", "gone");
    useThreadStore(store);
    let confirmed: string | null = null;
    const swept: Promise<void>[] = [];
    const sweeper = listingSweeper({
      residencies: () => ["cloud"],
      confirmed: () => confirmed,
      sweep: (listed, account) => {
        const run = sweepGoneProjectThreads(listed, account, async () => true);
        swept.push(run);
        return run;
      },
    });

    // The remembered last account is bound, and the listing comes back under it.
    sweeper.note("cloud", new Set(["listed"]), "remembered");
    await Promise.all(swept);
    expect(swept).toHaveLength(0);
    expect([...local.keys()]).toEqual([]);

    // The live session names someone else: that listing was another account's.
    confirmed = "signed-in";
    sweeper.retry();
    await Promise.all(swept);
    expect(swept).toHaveLength(0);
    expect([...lists.keys()].sort()).toEqual(["gone", "listed"]);

    // A listing fetched as the confirmed account sweeps.
    sweeper.note("cloud", new Set(["listed"]), "signed-in");
    await Promise.all(swept);
    expect(swept).toHaveLength(1);
    expect(local.get("cut-ai-owner-listed")).toBe("signed-in");
  });

  test("a listing fetched as the remembered account sweeps once the session confirms that account", async () => {
    useThreadStore(heldThreads("listed").store);
    let confirmed: string | null = null;
    const calls: string[] = [];
    const sweeper = listingSweeper({
      residencies: () => ["cloud", "browser"],
      confirmed: () => confirmed,
      sweep: async (_listed, account) => void calls.push(account),
    });
    sweeper.note("cloud", new Set(["listed"]), "me");
    sweeper.note("browser", new Set(), "me");
    expect(calls).toEqual([]);
    confirmed = "me";
    sweeper.retry();
    expect(calls).toEqual(["me"]);
  });

  test("every live residency has to have listed before anything sweeps", () => {
    const calls: string[] = [];
    const sweeper = listingSweeper({
      residencies: () => ["cloud", "browser"],
      confirmed: () => "me",
      sweep: async (_listed, account) => void calls.push(account),
    });
    sweeper.note("cloud", new Set(), "me");
    expect(calls).toEqual([]);
    sweeper.note("browser", new Set(), "me");
    expect(calls).toEqual(["me"]);
  });
});
