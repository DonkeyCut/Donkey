import { describe, expect, test } from "bun:test";

import type { GenerateContentParameters } from "@google/genai";

import { applyContextCacheToRequest } from "./gemini-context-cache";
import type { GeminiClient } from "./gemini-client";

const longInstruction = "doctrine ".repeat(600);
const toolBlock = [
  {
    functionDeclarations: Array.from({ length: 20 }, (_, i) => ({
      name: `tool_${i}`,
      description: "an editing command ".repeat(20),
      parameters: { type: "object", properties: {} },
    })),
  },
];

function stubClient(): { client: GeminiClient; created: Record<string, unknown>[] } {
  const created: Record<string, unknown>[] = [];
  const live: { displayName?: string; name?: string; expireTime?: string }[] = [];
  const client = {
    models: {} as GeminiClient["models"],
    caches: {
      list: async () => ({
        async *[Symbol.asyncIterator]() {
          for (const c of live) yield c;
        },
      }),
      create: async (params: { model: string; config: Record<string, unknown> }) => {
        created.push(params.config);
        const name = `caches/${created.length}`;
        live.push({ displayName: String(params.config.displayName), name });
        return { name };
      },
    } as unknown as GeminiClient["caches"],
  };
  return { client, created };
}

function request(config: Record<string, unknown>): GenerateContentParameters {
  // A fresh model id per request keeps the process-wide memo from answering across tests.
  return { model: `gemini-test-${Math.random()}`, contents: [], config } as GenerateContentParameters;
}

describe("gemini context cache", () => {
  test("caches the instruction and the tools together, and sends neither inline", async () => {
    const { client, created } = stubClient();
    const params = request({ systemInstruction: longInstruction, tools: toolBlock });

    await applyContextCacheToRequest(params, client);

    expect(created).toHaveLength(1);
    expect(created[0].systemInstruction).toBe(longInstruction);
    expect(created[0].tools).toEqual(toolBlock);
    expect(params.config?.cachedContent).toBe("caches/1");
    expect(params.config?.systemInstruction).toBeUndefined();
    expect(params.config?.tools).toBeUndefined();
  });

  test("a turn routed to different tools gets its own cache", async () => {
    const { client, created } = stubClient();
    const model = "gemini-test-routing";
    const wide = { model, contents: [], config: { systemInstruction: longInstruction, tools: toolBlock } } as GenerateContentParameters;
    const narrow = {
      model,
      contents: [],
      config: { systemInstruction: longInstruction, tools: [{ functionDeclarations: toolBlock[0].functionDeclarations.slice(0, 5) }] },
    } as GenerateContentParameters;

    await applyContextCacheToRequest(wide, client);
    await applyContextCacheToRequest(narrow, client);

    expect(created).toHaveLength(2);
    expect(wide.config?.cachedContent).not.toBe(narrow.config?.cachedContent);
  });

  test("a tool block alone is large enough to cache", async () => {
    const { client, created } = stubClient();
    const params = request({ tools: toolBlock });

    await applyContextCacheToRequest(params, client);

    expect(created).toHaveLength(1);
    expect(created[0].systemInstruction).toBeUndefined();
    expect(params.config?.tools).toBeUndefined();
    expect(params.config?.cachedContent).toBe("caches/1");
  });

  test("a short head is left inline", async () => {
    const { client, created } = stubClient();
    const params = request({ systemInstruction: "be brief" });

    await applyContextCacheToRequest(params, client);

    expect(created).toHaveLength(0);
    expect(params.config?.systemInstruction).toBe("be brief");
    expect(params.config?.cachedContent).toBeUndefined();
  });

  test("a tool config keeps the call inline", async () => {
    const { client, created } = stubClient();
    const params = request({
      systemInstruction: longInstruction,
      tools: toolBlock,
      toolConfig: { functionCallingConfig: { mode: "ANY" } },
    });

    await applyContextCacheToRequest(params, client);

    expect(created).toHaveLength(0);
    expect(params.config?.tools).toEqual(toolBlock);
    expect(params.config?.cachedContent).toBeUndefined();
  });

  test("a caching failure leaves the request valid", async () => {
    const client = {
      models: {} as GeminiClient["models"],
      caches: {
        list: async () => {
          throw new Error("caching disabled");
        },
        create: async () => {
          throw new Error("caching disabled");
        },
      } as unknown as GeminiClient["caches"],
    };
    const params = request({ systemInstruction: longInstruction, tools: toolBlock });

    await applyContextCacheToRequest(params, client);

    expect(params.config?.systemInstruction).toBe(longInstruction);
    expect(params.config?.tools).toEqual(toolBlock);
    expect(params.config?.cachedContent).toBeUndefined();
  });
});
