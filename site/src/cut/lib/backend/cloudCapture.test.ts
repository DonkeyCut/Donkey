import { afterEach, expect, spyOn, test } from "bun:test";
import { bindCloudSession, captureCloudBackend, cloudBackend } from "./cloud";
import { DOC_SEQ_HEADER, DOC_WRITER_HEADER } from "./types";

afterEach(() => { bindCloudSession("", {}); });

test("background requests retain captured credentials after the process is rebound", async () => {
  const fetcher = spyOn(globalThis, "fetch").mockResolvedValue(new Response("{}"));
  try {
    bindCloudSession("https://first.invalid", { Authorization: "first" });
    const first = captureCloudBackend();
    bindCloudSession("https://second.invalid", { Authorization: "second" });
    await first.fetch("/api/cut/export/example", { headers: new Headers({ "X-Example": "value" }) });
    const [url, options] = fetcher.mock.calls[0];
    expect(url).toBe("https://first.invalid/api/cut-cloud/export/example");
    expect(new Headers(options?.headers).get("Authorization")).toBe("first");
    expect(new Headers(options?.headers).get("X-Example")).toBe("value");
    expect(first.url("/api/cut/export/example/file")).toBe("https://first.invalid/api/cut-cloud/export/example/file");
  } finally { fetcher.mockRestore(); }
});

test("each transport saves as its own writer, numbering its saves in order", async () => {
  const fetcher = spyOn(globalThis, "fetch").mockImplementation((async () => Response.json({ ok: true })) as typeof fetch);
  try {
    // A bound session and a backend captured from it are separate writers:
    // the server never builds one's stale save over the other's.
    bindCloudSession("https://worker.invalid", {});
    const captured = captureCloudBackend();
    const put = { method: "PUT", body: "{}" };
    await cloudBackend.fetch("/api/cut/projects/p1", put);
    await cloudBackend.fetch("/api/cut/projects/p1", put);
    await captured.fetch("/api/cut/projects/p1", put);
    const sent = fetcher.mock.calls.map(([, options]) => new Headers(options?.headers));
    const writers = sent.map((h) => h.get(DOC_WRITER_HEADER));
    expect(writers[0]).toBe(writers[1]);
    expect(writers[2]).not.toBe(writers[0]);
    expect(sent.map((h) => h.get(DOC_SEQ_HEADER))).toEqual(["1", "2", "1"]);
  } finally { fetcher.mockRestore(); }
});

test("a request the firewall throttled goes again once its window passes", async () => {
  const answers = [
    new Response("Too Many Requests", { status: 429, headers: { "Retry-After": "0", "Content-Type": "text/plain" } }),
    Response.json({ key: "k", url: "https://media.invalid/k" }),
  ];
  const fetcher = spyOn(globalThis, "fetch").mockImplementation((async () => answers.shift()!) as typeof fetch);
  try {
    const res = await cloudBackend.fetch("/api/cut/media/presign", { method: "POST", body: "{}" });
    expect(res.status).toBe(200);
    expect(fetcher.mock.calls.length).toBe(2);
  } finally { fetcher.mockRestore(); }
});

test("a throttle a route answers itself stands", async () => {
  // "Too many turns are running": the route's own verdict, with its reason.
  const fetcher = spyOn(globalThis, "fetch").mockImplementation(
    (async () => Response.json({ error: "Too many turns are running on this account." }, { status: 429 })) as typeof fetch
  );
  try {
    const res = await cloudBackend.fetch("/api/cut/turns", { method: "POST", body: "{}" });
    expect(res.status).toBe(429);
    expect(fetcher.mock.calls.length).toBe(1);
  } finally { fetcher.mockRestore(); }
});

test("a firewall refusal holds every request until its window passes", async () => {
  const WINDOW_MS = 100;
  const sentAt: number[] = [];
  const fetcher = spyOn(globalThis, "fetch").mockImplementation((async () => {
    sentAt.push(Date.now());
    return sentAt.length === 1
      ? new Response("Too Many Requests", { status: 429, headers: { "Retry-After": String(WINDOW_MS / 1000), "Content-Type": "text/plain" } })
      : Response.json({ ok: true });
  }) as typeof fetch);
  try {
    // The second request starts after the first was refused: it waits the
    // window out with it, so the burst does not refill the next window.
    const first = cloudBackend.fetch("/api/cut/projects", { method: "GET" });
    await new Promise((r) => setTimeout(r, 10));
    const second = cloudBackend.fetch("/api/cut/projects/p1", { method: "GET" });
    await Promise.all([first, second]);
    expect(sentAt.length).toBe(3);
    expect(Math.min(...sentAt.slice(1)) - sentAt[0]).toBeGreaterThanOrEqual(WINDOW_MS - 5);
  } finally { fetcher.mockRestore(); }
});
