import { afterEach, expect, test } from "bun:test";
import { runAiTool } from "./aiTools";

// The gallery lists for a caller whose favorites cannot be read: signed out,
// or an environment without the favorites table.

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

const TEMPLATE = {
  id: "t1",
  name: { en: "Launch" },
  description: { en: "A product launch." },
  category: "product",
  aspect: "9:16",
  style: "clean",
  seconds: 12,
  slots: 2,
  texts: 1,
};

function serve(favoritesStatus: number) {
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.includes("favorites")) {
      return Response.json({ error: "no" }, { status: favoritesStatus });
    }
    return Response.json({ templates: [TEMPLATE] });
  }) as typeof fetch;
}

test("the gallery lists when the favorites read fails", async () => {
  serve(401);
  const out = (await runAiTool("template_gallery", {})) as { total?: number; error?: string };
  expect(out.total).toBe(1);
});

test("a favorites listing says the favorites could not be read", async () => {
  serve(500);
  expect(runAiTool("template_gallery", { source: "favorites" })).rejects.toThrow();
});
