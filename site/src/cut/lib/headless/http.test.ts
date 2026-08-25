import { afterEach, describe, expect, test } from "bun:test";
import { fetchWithRetry } from "./http";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

/** Stand in for the network: answers each call from `answers` in order. */
function stubFetch(answers: (Response | Error)[]) {
  const calls: string[] = [];
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push(String((init?.method ?? "GET").toUpperCase()));
    const next = answers[Math.min(calls.length - 1, answers.length - 1)];
    if (next instanceof Error) throw next;
    return next;
  }) as typeof fetch;
  return calls;
}

describe("fetchWithRetry", () => {
  test("a read is asked again when the gateway is out", async () => {
    const calls = stubFetch([
      new Response("", { status: 502 }),
      new Response("", { status: 502 }),
      new Response("ok", { status: 200 }),
    ]);
    const res = await fetchWithRetry("https://x/y", {}, "read the project");
    expect(res.status).toBe(200);
    expect(calls.length).toBe(3);
  });

  test("a write is sent once, so a landed save is never resent", async () => {
    // The second send would answer 409 — the doc version has already moved —
    // and a saved project would be reported as a concurrent writer.
    const calls = stubFetch([new Response("", { status: 502 })]);
    const res = await fetchWithRetry("https://x/y?v=3", { method: "PUT" }, "save the project");
    expect(res.status).toBe(502);
    expect(calls).toEqual(["PUT"]);
  });

  test("a write that says it is safe to repeat is repeated", async () => {
    const calls = stubFetch([
      new Response("", { status: 503 }),
      new Response("ok", { status: 200 }),
    ]);
    const res = await fetchWithRetry(
      "https://x/presign",
      { method: "POST" },
      "sign the media URLs",
      { retry: true }
    );
    expect(res.status).toBe(200);
    expect(calls.length).toBe(2);
  });

  test("a network that never answers names the call it gave up on", async () => {
    stubFetch([new Error("fetch failed")]);
    let message = "";
    try {
      await fetchWithRetry("https://x/y", { method: "PUT" }, "save project p1");
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toContain("Could not save project p1");
    expect(message).toContain("fetch failed");
  });
});
