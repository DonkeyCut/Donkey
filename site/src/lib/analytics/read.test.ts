import { expect, mock, test } from "bun:test";
import { z } from "zod";

import { R2NotConfiguredError } from "@/cut/server/cloud/r2";

// Storage is the thing under test here: what the rollup reader does when the
// bucket answers "nothing stored" versus when it refuses to answer at all.
let stored: { bytes: Buffer; mime: string } | null = null;
let failure: Error | null = null;
mock.module("@/cut/server/cloud/r2", () => ({
  R2NotConfiguredError,
  readObject: async () => {
    if (failure) throw failure;
    return stored;
  },
}));

const { noRollupResponse, readRollup, storageProblemResponse } = await import("./read");

test("an empty bucket is no rollup", async () => {
  stored = null;
  failure = null;
  expect(await readRollup()).toBeNull();
});

test("storage refusing the read is not an empty bucket", async () => {
  stored = null;
  failure = new Error("Access Denied");
  expect(readRollup()).rejects.toThrow("Access Denied");
});

test("the empty answer carries the code a client keys its empty state on", async () => {
  const response = noRollupResponse();
  expect(response.status).toBe(404);
  expect(await response.json()).toMatchObject({ error: "no-rollup" });
});

test("unconfigured storage says so, as a 503", async () => {
  const response = storageProblemResponse(new R2NotConfiguredError());
  expect(response.status).toBe(503);
  expect(await response.json()).toMatchObject({ error: "storage-unconfigured" });
});

test("a refused read is a 503 repeating what storage said", async () => {
  const response = storageProblemResponse(new Error("Access Denied"));
  expect(response.status).toBe(503);
  const body = (await response.json()) as { error: string; message: string };
  expect(body.error).toBe("storage-unreadable");
  expect(body.message).toContain("Access Denied");
});

test("a stored rollup this build can't parse names the field", async () => {
  const parsed = z.object({ days: z.array(z.string()) }).safeParse({ days: 3 });
  const response = storageProblemResponse(parsed.error);
  expect(response.status).toBe(500);
  const body = (await response.json()) as { error: string; message: string };
  expect(body.error).toBe("rollup-unreadable");
  expect(body.message).toContain("days");
});
