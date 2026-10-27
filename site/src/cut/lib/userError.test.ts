import { describe, expect, test } from "bun:test";

import { err } from "./backend/browser/respond";
import { errorBody, errorFields, errorFromBody, failureCode, failureText, replyError, UserError } from "./userError";
import { errorRecord, errorReply } from "../server/util";

// A failure crosses JSON as `{ error, code, params }` (a reply) or
// `{ error, errorCode, errorParams }` (a record). Either way the reader gets
// back the same code, values and English it was raised with.

const roundTrip = (value: unknown): unknown => JSON.parse(JSON.stringify(value));

describe("a coded failure across a reply body", () => {
  test("keeps its code, values and English", () => {
    const raised = new UserError("file_read_failed", "Could not read clip.mov.", { name: "clip.mov" });
    const read = errorFromBody(roundTrip(errorBody(raised, "fallback")), "fallback");
    expect(read instanceof UserError).toBe(true);
    expect(failureCode(read)).toEqual({ code: "file_read_failed", params: { name: "clip.mov" } });
    expect(read.message).toBe("Could not read clip.mov.");
  });

  test("an uncoded failure keeps its own words and no code", () => {
    const read = errorFromBody(roundTrip(errorBody(new Error("ffmpeg exited 1"), "fallback")), "fallback");
    expect(read instanceof UserError).toBe(false);
    expect(read.message).toBe("ffmpeg exited 1");
  });

  test("an empty body reads as the fallback", () => {
    const fallback = new UserError("folder_create_failed", "Could not create folder.");
    expect(errorFromBody(null, fallback)).toBe(fallback);
    expect(errorFromBody({}, "Upload failed.").message).toBe("Upload failed.");
  });

  test("a system error's code never reads as a catalog code", () => {
    const enoent = Object.assign(new Error("ENOENT: no such file"), { code: "ENOENT" });
    expect(failureCode(enoent)).toBeNull();
    expect(errorBody(enoent, "x")).toEqual({ error: "ENOENT: no such file" });
  });
});

describe("a coded failure across a record", () => {
  test("rides beside `error` as errorCode and errorParams", () => {
    const fields = errorFields(new UserError("export_canceled", "Export canceled."), "Export failed.");
    expect(fields).toEqual({ error: "Export canceled.", errorCode: "export_canceled", errorParams: {} });
    const job = roundTrip({ status: "error", progress: 0.4, ...fields });
    expect(failureCode(job)).toEqual({ code: "export_canceled", params: {} });
    expect(failureText(job)).toBe("Export canceled.");
    expect(errorFromBody(job, "x") instanceof UserError).toBe(true);
  });
});

describe("replies on each residency", () => {
  test("the browser backend answers a UserError with its code", async () => {
    const res = err(new UserError("project_not_found", "Project not found."), 404);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "Project not found.", code: "project_not_found", params: {} });
  });

  test("the engine words a full disk as the coded disk_full", () => {
    const full = Object.assign(new Error("ENOSPC: write /Users/x/Movies"), { code: "ENOSPC" });
    expect(errorReply(full, "x")).toMatchObject({ code: "disk_full" });
    expect(errorRecord(full, "x")).toMatchObject({ errorCode: "disk_full" });
  });

  test("a storage wall's code-only body reads as the wall", () => {
    const read = replyError(413, { error: "storage_quota_exceeded", bytes: 1, quotaBytes: 2 }, "Upload failed.");
    expect(failureCode(read)).toEqual({ code: "storage_quota_exceeded", params: {} });
    expect(read.message).toBe("Cloud storage is full.");
  });
});
