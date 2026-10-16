import { afterAll, describe, expect, spyOn, test } from "bun:test";

import { bindFailureSink, reportSwallowed } from "./report";

type Sent = { error: Error; fingerprint: string };

const sent: Sent[] = [];
bindFailureSink((error, fingerprint) => sent.push({ error, fingerprint }));

const warn = spyOn(console, "warn").mockImplementation(() => {});
afterAll(() => warn.mockRestore());

/** Report one failure and hand back what reached the sink. */
const report = (what: string, err: unknown, subject?: string): Sent | undefined => {
  sent.length = 0;
  reportSwallowed(what, err, subject);
  return sent[0];
};

describe("reportSwallowed", () => {
  test("names the file in the message and keeps it out of the grouping", () => {
    const a = report("[cut] peaks failed", new Error("Decoding error."), "IMG_7087.MOV");
    const b = report("[cut] peaks failed", new Error("Decoding error."), "IMG_7091.MOV");

    expect(a?.error.message).toBe("[cut] peaks failed for IMG_7087.MOV");
    expect(b?.error.message).toBe("[cut] peaks failed for IMG_7091.MOV");
    expect(a?.fingerprint).toBe(b!.fingerprint);
  });

  test("keeps different causes of one failure apart", () => {
    const decode = report("[cut] enrich failed", new DOMException("Decoding error.", "EncodingError"), "a.mp4");
    const read = report("[cut] enrich failed", new Error("Cloud media read failed (404)."), "a.mp4");

    expect(decode?.fingerprint).not.toBe(read!.fingerprint);
  });

  test("carries the cause behind the report", () => {
    const cause = new Error("Decoding error.");

    expect(report("[cut] paste failed", cause)?.error.cause).toBe(cause);
  });

  test("leaves signed URLs out of the grouping", () => {
    const one = report("[cut] drop failed", new Error("Error fetching https://media.donkeycut.com/a?s=1"), "a");
    const two = report("[cut] drop failed", new Error("Error fetching https://media.donkeycut.com/b?s=2"), "b");

    expect(one?.fingerprint).toBe(two!.fingerprint);
  });

  test("sends a dropped connection to the console only", () => {
    expect(report("[cut] peaks failed", new TypeError("Failed to fetch"), "a.mp4")).toBeUndefined();
  });
});
