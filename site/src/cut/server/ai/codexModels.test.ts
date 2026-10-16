import { describe, expect, test } from "bun:test";
import { CODEX_CATALOG_TTL_MS, codexAccountModels, createCodexCatalog } from "./codexModels";

describe("codexAccountModels", () => {
  test("reads the slugs from `codex debug models`", () => {
    const out = JSON.stringify({
      models: [
        { slug: "gpt-6-luna", visibility: "list" },
        { slug: "gpt-5.6-terra", visibility: "list" },
      ],
    });
    expect(codexAccountModels(out)).toEqual(["gpt-6-luna", "gpt-5.6-terra"]);
  });

  test("names no list when the output is not a catalog", () => {
    expect(codexAccountModels("")).toBeUndefined();
    expect(codexAccountModels("error: unrecognized subcommand 'debug'")).toBeUndefined();
    expect(codexAccountModels(JSON.stringify({ models: "x" }))).toBeUndefined();
  });
});

describe("createCodexCatalog", () => {
  const flush = () => new Promise((r) => setTimeout(r, 0));

  test("never waits on a read and serves the last catalog while one runs", async () => {
    let clock = 0;
    const reads: ((models: string[] | undefined) => void)[] = [];
    const catalog = createCodexCatalog(() => new Promise((r) => reads.push(r)), () => clock);

    // The first ask starts a read and answers at once with nothing known.
    expect(catalog.current()).toBeUndefined();
    expect(reads.length).toBe(1);

    // Asks while the read runs start no second one.
    expect(catalog.current()).toBeUndefined();
    expect(reads.length).toBe(1);

    reads[0](["gpt-6-luna"]);
    await flush();
    expect(catalog.current()).toEqual(["gpt-6-luna"]);
    expect(reads.length).toBe(1);

    // A stale catalog still answers while its refresh runs.
    clock += CODEX_CATALOG_TTL_MS;
    expect(catalog.current()).toEqual(["gpt-6-luna"]);
    expect(reads.length).toBe(2);

    // A failed refresh keeps the last catalog.
    reads[1](undefined);
    await flush();
    expect(catalog.current()).toEqual(["gpt-6-luna"]);
    expect(reads.length).toBe(2);
  });
});
