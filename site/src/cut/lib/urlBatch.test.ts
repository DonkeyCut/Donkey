import { describe, expect, test } from "bun:test";
import { importEach, URL_BATCH_MAX, URL_DOWNLOADS_MAX, URL_BUSY_MESSAGE } from "./urlBatch";

describe("importEach", () => {
  test("answers in the order asked, a few at a time", async () => {
    let live = 0;
    let peak = 0;
    const urls = ["a", "b", "c", "d", "e", "f", "g"];
    const out = await importEach(urls, async (u) => {
      live++;
      peak = Math.max(peak, live);
      await new Promise((r) => setTimeout(r, u === "a" ? 30 : 5));
      live--;
      return u.toUpperCase();
    });
    expect(out.map((r) => r.url)).toEqual(urls);
    expect(out.map((r) => ("value" in r ? r.value : null))).toEqual(urls.map((u) => u.toUpperCase()));
    expect(peak).toBeGreaterThan(1);
    // Never more than the local server lets download at once, or the extra
    // lanes are turned away as busy.
    expect(peak).toBeLessThanOrEqual(URL_DOWNLOADS_MAX);
  });

  test("one failure is reported on its own row and the rest still land", async () => {
    const out = await importEach(["ok1", "bad", "ok2"], async (u) => {
      if (u === "bad") throw new Error("404 from host");
      return u;
    });
    expect(out[0]).toEqual({ url: "ok1", value: "ok1" });
    expect(out[1]).toEqual({ url: "bad", error: "404 from host" });
    expect(out[2]).toEqual({ url: "ok2", value: "ok2" });
  });

  test("blank and repeated urls are dropped, and the batch is capped", async () => {
    const out = await importEach([" a ", "", "a", "b"], async (u) => u);
    expect(out.map((r) => r.url)).toEqual(["a", "b"]);
    const many = Array.from({ length: URL_BATCH_MAX + 5 }, (_, i) => `u${i}`);
    await expect(importEach(many, async (u) => u)).rejects.toThrow(String(URL_BATCH_MAX));
  });

  test("a link turned away as busy waits its turn and lands", async () => {
    let tries = 0;
    const out = await importEach(
      ["a", "b"],
      async (u) => {
        if (u === "a" && tries++ < 2) throw new Error(URL_BUSY_MESSAGE);
        return u;
      },
      { busyWaitMs: 5 }
    );
    expect(out).toEqual([{ url: "a", value: "a" }, { url: "b", value: "b" }]);
    expect(tries).toBe(3);
  });

  test("a batch answers within its budget: what landed, what is still downloading, what never started", async () => {
    const t0 = Date.now();
    const out = await importEach(
      ["a", "b", "c", "d", "e", "f"],
      async (u) => {
        await new Promise((r) => setTimeout(r, 60));
        return u;
      },
      { budgetMs: 90 }
    );
    expect(Date.now() - t0).toBeLessThan(140);
    expect(out.slice(0, 2)).toEqual([{ url: "a", value: "a" }, { url: "b", value: "b" }]);
    expect(out.slice(2, 4)).toEqual([{ url: "c", pending: true }, { url: "d", pending: true }]);
    expect(out.slice(4)).toEqual([{ url: "e", notStarted: true }, { url: "f", notStarted: true }]);
  });

  test("a link still waiting for a slot when the budget runs out is reported as never started", async () => {
    const out = await importEach(
      ["a"],
      async () => {
        throw new Error(URL_BUSY_MESSAGE);
      },
      { busyWaitMs: 20, budgetMs: 50 }
    );
    expect(out).toEqual([{ url: "a", notStarted: true }]);
  });
});
