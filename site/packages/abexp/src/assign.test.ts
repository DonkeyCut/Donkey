import { describe, expect, test } from "bun:test";

import { EVERYONE, type AudienceFacts } from "./audience";
import { bucket, isEligible, pickVariant, type AssignableExperiment, type AssignContext } from "./assign";

const experiment = (over: Partial<AssignableExperiment> = {}): AssignableExperiment => ({
  key: "copy_test",
  status: "running",
  variants: [
    { key: "control", name: "Control", weight: 50, config: {} },
    { key: "treatment", name: "Treatment", weight: 50, config: {} },
  ],
  audience: EVERYONE,
  percent: 100,
  ...over,
});

const facts = (over: Partial<AudienceFacts> = {}): AudienceFacts => ({
  country: "US",
  createdAt: new Date("2026-09-01T00:00:00Z"),
  pro: false,
  paid: false,
  lastActiveAt: null,
  storageUsedPercent: null,
  creditsUsedPercent: null,
  ...over,
});

const ctx = (over: { userId?: string; facts?: Partial<AudienceFacts> } = {}): AssignContext => ({
  userId: over.userId ?? "user_1",
  facts: facts(over.facts),
  now: new Date("2026-09-04T00:00:00Z"),
});

const ids = Array.from({ length: 20_000 }, (_, i) => `user_${i}`);

describe("assignment", () => {
  test("is deterministic", () => {
    expect(bucket("k", "u", "rollout")).toBe(bucket("k", "u", "rollout"));
    expect(bucket("k", "u", "rollout")).not.toBe(bucket("k", "u", "variant"));
    expect(pickVariant(experiment(), "user_7")).toBe(pickVariant(experiment(), "user_7"));
  });

  test("splits 20k ids by weight within two points", () => {
    const exp = experiment({
      variants: [
        { key: "a", name: "A", weight: 70, config: {} },
        { key: "b", name: "B", weight: 30, config: {} },
      ],
    });
    let a = 0;
    for (const id of ids) if (pickVariant(exp, id) === "a") a++;
    const share = (a / ids.length) * 100;
    expect(Math.abs(share - 70)).toBeLessThan(2);
  });

  test("never picks a zero-weight variant", () => {
    const exp = experiment({
      variants: [
        { key: "off", name: "Off", weight: 0, config: {} },
        { key: "on", name: "On", weight: 1, config: {} },
      ],
    });
    for (const id of ids.slice(0, 2000)) expect(pickVariant(exp, id)).toBe("on");
    expect(pickVariant(experiment({ variants: [{ key: "x", name: "X", weight: 0, config: {} }] }), "u")).toBeNull();
  });

  test("raising the percent only adds users and keeps their variant", () => {
    const at20 = experiment({ percent: 20 });
    const at60 = experiment({ percent: 60 });
    let enrolled20 = 0;
    for (const id of ids) {
      const c = ctx({ userId: id });
      if (isEligible(at20, c)) {
        enrolled20++;
        expect(isEligible(at60, c)).toBe(true);
        expect(pickVariant(at60, id)).toBe(pickVariant(at20, id));
      }
    }
    expect(Math.abs((enrolled20 / ids.length) * 100 - 20)).toBeLessThan(2);
  });

  test("the audience gates eligibility", () => {
    const pro = experiment({ audience: { ...EVERYONE, plan: "pro" } });
    expect(isEligible(pro, ctx())).toBe(false);
    expect(isEligible(pro, ctx({ facts: { pro: true } }))).toBe(true);
  });

  test("only a running experiment is eligible", () => {
    for (const status of ["draft", "paused", "ended"]) {
      expect(isEligible(experiment({ status }), ctx())).toBe(false);
    }
    expect(isEligible(experiment(), ctx())).toBe(true);
  });
});
