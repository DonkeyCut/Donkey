import { describe, expect, test } from "bun:test";

import {
  collectable,
  withPending,
  withPublished,
  type LadderRecord,
  type LadderVersion,
} from "./ladderStore";

const USER = "user1";
const version = (v: string, over: Partial<LadderVersion> = {}): LadderVersion => ({
  version: v,
  duration: 120,
  burnedSubtitles: false,
  ...over,
});

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

describe("claiming a version", () => {
  test("a version is indexed before any of its bytes exist", () => {
    // The record is the only index of ladder trees. A version that uploaded
    // before being named here would be invisible to every sweep if the job
    // then died, leaking a whole cut's worth of segments with nothing left
    // that could find them.
    const next = withPending({ userId: USER }, USER, "v1", 1000);
    expect(next.pending).toEqual([{ version: "v1", at: 1000 }]);
  });

  test("a retried version is re-stamped, not duplicated", () => {
    const first = withPending({ userId: USER }, USER, "v1", 1000);
    const again = withPending(first, USER, "v1", 5000);
    expect(again.pending).toEqual([{ version: "v1", at: 5000 }]);
  });

  test("claiming leaves what is already published alone", () => {
    const live: LadderRecord = { userId: USER, current: version("v1") };
    expect(withPending(live, USER, "v2", 1000).current).toEqual(version("v1"));
  });
});

describe("publishing a version", () => {
  test("the replaced version is retired at the moment it was replaced", () => {
    // Not at the moment its bytes were written — that is the clock the sweep's
    // grace has to run on, and a ladder built weeks ago is already long past
    // any age-based cutoff.
    const live: LadderRecord = { userId: USER, current: version("v1") };
    const next = withPublished(live, USER, version("v2"), 9_000);
    expect(next.retired).toEqual([{ version: "v1", at: 9_000 }]);
    expect(next.current?.version).toBe("v2");
  });

  test("publishing clears its own pending claim", () => {
    const claimed = withPending({ userId: USER }, USER, "v1", 1000);
    expect(withPublished(claimed, USER, version("v1"), 2000).pending).toEqual([]);
  });

  test("republishing the same version retires nothing", () => {
    // The two-pass ladder publishes twice under one version; the second must
    // not retire the ladder it is still writing.
    const live: LadderRecord = { userId: USER, current: version("v1") };
    expect(withPublished(live, USER, version("v1", { duration: 300 }), 9_000).retired).toEqual([]);
  });

  test("a first publish retires nothing", () => {
    expect(withPublished({ userId: USER }, USER, version("v1"), 1000).retired).toEqual([]);
  });

  test("the retired list is bounded", () => {
    let record: LadderRecord = { userId: USER };
    for (let i = 0; i < 40; i++) record = withPublished(record, USER, version(`v${i}`), i * 1000);
    expect(record.retired!.length).toBeLessThanOrEqual(12);
    // What it keeps is the most recent, which is what still has viewers.
    expect(record.retired!.at(-1)!.version).toBe("v38");
  });
});

describe("what a sweep may collect", () => {
  const record: LadderRecord = {
    userId: USER,
    current: version("v3"),
    retired: [
      { version: "v1", at: 0 },
      { version: "v2", at: 0 },
    ],
    pending: [{ version: "v4", at: 0 }],
  };

  test("nothing goes before its grace has run", () => {
    expect(collectable(record, HOUR, DAY, 6 * HOUR)).toEqual([]);
  });

  test("a retired version survives until its own grace has run", () => {
    // The grace exists for the viewer holding that ladder mid-watch, so the
    // two clocks are checked apart: retired is the slower one.
    const retiredOnly: LadderRecord = {
      userId: USER,
      current: version("v3"),
      retired: [{ version: "v1", at: 0 }],
    };
    expect(collectable(retiredOnly, DAY - 1, DAY, 6 * HOUR)).toEqual([]);
    expect(collectable(retiredOnly, DAY, DAY, 6 * HOUR)).toEqual(["v1"]);
  });

  test("a pending version goes once it is too old to still be rendering", () => {
    // Its render died partway; the segments it uploaded are garbage nothing
    // else in the system can find.
    const pendingOnly: LadderRecord = {
      userId: USER,
      current: version("v3"),
      pending: [{ version: "v4", at: 0 }],
    };
    expect(collectable(pendingOnly, 6 * HOUR - 1, DAY, 6 * HOUR)).toEqual([]);
    expect(collectable(pendingOnly, 6 * HOUR, DAY, 6 * HOUR)).toEqual(["v4"]);
  });

  test("both clocks run independently", () => {
    // Past the retired grace, everything aged out of either list goes.
    expect(collectable(record, DAY, DAY, 6 * HOUR).sort()).toEqual(["v1", "v2", "v4"]);
  });

  test("a live render's claim is left alone", () => {
    expect(collectable(record, HOUR, DAY, 6 * HOUR)).not.toContain("v4");
  });

  test("what is being served is never collectable", () => {
    // Even if it somehow appears in both lists — a record written by an older
    // build, a publish that raced a retire — the current tree stays.
    const confused: LadderRecord = {
      ...record,
      retired: [...record.retired!, { version: "v3", at: 0 }],
      pending: [...record.pending!, { version: "v3", at: 0 }],
    };
    expect(collectable(confused, 10 * DAY, DAY, 6 * HOUR)).not.toContain("v3");
  });

  test("a version listed twice is returned once", () => {
    const dupe: LadderRecord = {
      userId: USER,
      current: version("v9"),
      retired: [{ version: "v1", at: 0 }],
      pending: [{ version: "v1", at: 0 }],
    };
    expect(collectable(dupe, 10 * DAY, DAY, 6 * HOUR)).toEqual(["v1"]);
  });

  test("a record with nothing retired or pending collects nothing", () => {
    expect(collectable({ userId: USER, current: version("v1") }, 10 * DAY, DAY, 6 * HOUR)).toEqual(
      []
    );
  });
});
