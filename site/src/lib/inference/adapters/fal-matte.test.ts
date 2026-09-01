import { describe, expect, test } from "bun:test";

import { createFalMatteProvider } from "./fal-matte";
import { falMatteModels } from "@/lib/inference/matte-models";

const generation = (providerPollingUrl: string) => ({
  id: "gen-1",
  kind: "matte" as const,
  provider: "fal",
  model: falMatteModels.segmenter,
  providerJobId: "req-1",
  providerGenerationId: "req-1",
  providerPollingUrl,
  outputs: [],
  metadata: {},
});

describe("fal matte provider", () => {
  test("a poll address off the queue host never receives the key", async () => {
    const calls: string[] = [];
    const provider = createFalMatteProvider({ FAL_KEY: "secret" }, (async (
      url: string | URL | Request,
    ) => {
      calls.push(String(url));
      return new Response("{}", { status: 200 });
    }) as typeof fetch);

    let refused = "";
    try {
      await provider.refreshAsset!(
        generation("https://attacker.example/collect"),
      );
    } catch (e) {
      refused = e instanceof Error ? e.message : String(e);
    }
    expect(refused).toContain("off the queue host");
    expect(calls).toEqual([]);
  });

  test("a poll address on the queue host is polled with the key", async () => {
    const seen: { url: string; auth: string | null }[] = [];
    const provider = createFalMatteProvider({ FAL_KEY: "secret" }, (async (
      url: string | URL | Request,
      init?: RequestInit,
    ) => {
      seen.push({
        url: String(url),
        auth: new Headers(init?.headers).get("authorization"),
      });
      return Response.json({ status: "IN_PROGRESS" });
    }) as typeof fetch);

    const result = await provider.refreshAsset!(
      generation("https://queue.fal.run/fal-ai/model/requests/req-1"),
    );
    expect(result.status).toBe("in_progress");
    expect(seen).toEqual([
      {
        url: "https://queue.fal.run/fal-ai/model/requests/req-1/status",
        auth: "Key secret",
      },
    ]);
  });
});
