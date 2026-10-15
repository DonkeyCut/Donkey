import { describe, expect, test } from "bun:test";
import { codexAccountModels } from "./codexModels";

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
