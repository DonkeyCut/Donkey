import { expect, test } from "bun:test";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

test("unsubscribed email is skipped and existing failures settle without sending", async () => {
  // Isolate module mocks from the rest of the test suite.
  const { stdout, stderr } = await promisify(execFile)(process.execPath, [
    "run", fileURLToPath(new URL("./fixtures/unsubscribed.ts", import.meta.url)),
  ]);
  expect({ stdout, stderr }).toEqual({ stdout: "", stderr: "" });
});
