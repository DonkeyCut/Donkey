import { describe, expect, test } from "bun:test";
import { harvestIds, ledgerText, recordCall, type LedgerRecord } from "./mutationLedger";

describe("recordCall", () => {
  // Both keep a picture box on the source: find_picture always, detect_cuts
  // on its first read of a source, which its result says.
  test("a reading that kept a picture box is an edit", () => {
    const records: LedgerRecord[] = [];
    recordCall(records, "find_picture", { picture: { x: 0.5, y: 0.5, w: 1, h: 0.5 } }, undefined);
    recordCall(records, "detect_cuts", { cuts: [], pictureKept: true }, undefined);
    recordCall(records, "detect_cuts", { cuts: [] }, undefined);
    recordCall(records, "detect_cuts", undefined, "Could not read the source.");
    expect(records.map((r) => r.name)).toEqual(["find_picture", "detect_cuts"]);
  });

  test("a read leaves no record and a mutation keeps its ids", () => {
    const records: LedgerRecord[] = [];
    recordCall(records, "get_state", { videoTrack: [] }, undefined);
    recordCall(records, "set_clip_muted", { id: "c1", muted: true }, undefined);
    expect(records).toEqual([{ name: "set_clip_muted", ids: ["c1"] }]);
  });

  // A sweep returns a value when some of its ids land and others do not, so
  // the ledger reads the shortfall out of the result: the reply has to own
  // the ones that failed.
  test("a sweep that half landed records what changed and what did not", () => {
    const records: LedgerRecord[] = [];
    recordCall(
      records,
      "set_clip_muted",
      {
        ran: 2,
        ids: ["c1", "c3"],
        results: [{ id: "c1" }, { id: "c3" }],
        failed: [{ id: "c2", error: "No video clip with id c2." }],
      },
      undefined,
    );
    expect(records[0]).toEqual({ name: "set_clip_muted", ids: ["c1", "c3"] });
    expect(records[1].error).toContain("c2: No video clip with id c2.");
    const text = ledgerText(records, [])!;
    expect(text).toContain("ran: set_clip_muted (c1, c3)");
    expect(text).toContain("FAILED: set_clip_muted");
  });

  test("a sweep with nothing left over records no failure", () => {
    const records: LedgerRecord[] = [];
    recordCall(records, "delete_item", { ran: 2, ids: ["ov1", "ov2"], results: [] }, undefined);
    expect(records).toHaveLength(1);
    expect(records[0].error).toBeUndefined();
  });
});

describe("harvestIds", () => {
  test("a sweep's landed ids come off the top level", () => {
    expect(harvestIds({ ran: 2, ids: ["c1", "c2"], results: [{ id: "c9" }] })).toEqual(["c1", "c2"]);
  });
});
