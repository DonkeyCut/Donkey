import { describe, expect, test } from "bun:test";
import path from "node:path";
import { codexBundleCandidates, resolveCodex } from "./tool-path";

const home = "/Users/someone";
const bundled = codexBundleCandidates(home);

describe("resolveCodex", () => {
  test("lists the system and the user Applications bundles", () => {
    expect(bundled).toEqual([
      "/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex",
      path.join(home, "Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex"),
    ]);
  });

  test("a codex on PATH wins over the bundled copy", async () => {
    const asked: string[] = [];
    const resolved = await resolveCodex({
      onPath: async (name) => (name === "codex" ? "/opt/homebrew/bin/codex" : null),
      executable: async (p) => {
        asked.push(p);
        return true;
      },
      home,
    });
    expect(resolved).toBe("/opt/homebrew/bin/codex");
    expect(asked).toEqual([]);
  });

  test("the bundled copy is used when PATH has none", async () => {
    const resolved = await resolveCodex({
      onPath: async () => null,
      executable: async (p) => p === bundled[1],
      home,
    });
    expect(resolved).toBe(bundled[1]);
  });

  test("nothing installed resolves to null", async () => {
    const resolved = await resolveCodex({
      onPath: async () => null,
      executable: async () => false,
      home,
    });
    expect(resolved).toBeNull();
  });
});
