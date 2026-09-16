import { afterEach, expect, spyOn, test } from "bun:test";
import { bindCloudSession, captureCloudBackend } from "./cloud";

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
