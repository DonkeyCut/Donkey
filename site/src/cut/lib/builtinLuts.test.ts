import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseLutFile } from "@donkeycut/effects-kit";
import { BUILTIN_LUTS } from "./builtinLuts";
import { contentKey } from "./contentKey";

const PUBLIC = path.join(path.dirname(fileURLToPath(import.meta.url)), "../../../public");

describe("built-in LUTs", () => {
  test("every manifest entry names the bytes it ships", async () => {
    for (const l of BUILTIN_LUTS) {
      const bytes = readFileSync(path.join(PUBLIC, l.file));
      const buf = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
      expect({ id: l.id, key: await contentKey(buf) }).toEqual({ id: l.id, key: l.key });
      expect(parseLutFile(l.file, bytes.toString("utf8")).cube?.size).toBe(33);
    }
  });

  test("every look says what it does to a picture", () => {
    for (const l of BUILTIN_LUTS) expect(l.look.trim().length).toBeGreaterThan(10);
  });

  test("ids and labels are unique", () => {
    expect(new Set(BUILTIN_LUTS.map((l) => l.id)).size).toBe(BUILTIN_LUTS.length);
    expect(new Set(BUILTIN_LUTS.map((l) => l.label)).size).toBe(BUILTIN_LUTS.length);
  });
});
