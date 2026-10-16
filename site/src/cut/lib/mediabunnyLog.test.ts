import { afterAll, describe, expect, spyOn, test } from "bun:test";
import { Logging } from "mediabunny";

import "./mediabunnyLog";
import { bindFailureSink } from "./report";

// Logging._error is how mediabunny itself logs; it is internal, so reach it
// through a cast.
const logError = (...args: unknown[]) => (Logging as unknown as { _error(...a: unknown[]): void })._error(...args);

const reports: string[] = [];
bindFailureSink((error) => reports.push(error.message));
const warn = spyOn(console, "warn").mockImplementation(() => {});
const error = spyOn(console, "error").mockImplementation(() => {});

afterAll(() => {
  bindFailureSink((e) => console.error(e));
  warn.mockRestore();
  error.mockRestore();
});

describe("mediabunny's error log", () => {
  test("a fetch it retries is a warning", () => {
    logError("Retrying failed fetch. Error:", new TypeError("Load failed"));

    expect(reports).toEqual([]);
    expect(error).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalled();
  });

  test("anything else is reported in its own words", () => {
    logError("Error parsing AVC SPS:", new Error("Invalid exponential-Golomb code."));

    expect(reports).toEqual(["[mediabunny] Error parsing AVC SPS:"]);
    expect(error).not.toHaveBeenCalled();
  });
});
