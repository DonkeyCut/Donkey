import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";

const STARTER = path.join(process.cwd(), "public", "cut-starter");

// Every fileName anywhere in the doc: masters, proxies, and whatever else
// points at a media file.
function fileNames(value: unknown, out: string[] = []): string[] {
  if (Array.isArray(value)) {
    value.forEach((v) => fileNames(v, out));
  } else if (value && typeof value === "object") {
    for (const [key, v] of Object.entries(value)) {
      if (key === "fileName" && typeof v === "string") {
        out.push(v);
      } else {
        fileNames(v, out);
      }
    }
  }
  return out;
}

describe("starter project", () => {
  // The seed copies the media folder into each new account; a doc that names
  // a file outside it 404s in every new account.
  test("every file the doc names ships in its media folder", () => {
    const doc = JSON.parse(fs.readFileSync(path.join(STARTER, "project.json"), "utf8"));
    const shipped = new Set(fs.readdirSync(path.join(STARTER, "media")));
    expect(fileNames(doc).filter((name) => !shipped.has(name))).toEqual([]);
  });
});
