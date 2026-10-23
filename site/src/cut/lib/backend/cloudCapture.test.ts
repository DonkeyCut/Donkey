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
