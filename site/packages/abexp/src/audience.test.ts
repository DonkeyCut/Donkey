import { describe, expect, test } from "bun:test";

import {
  audienceNeeds,
  audienceSchema,
  describeAudience,
  EVERYONE,
  matchesAudience,
  type AudienceFacts,
} from "./audience";

const now = new Date("2026-09-04T00:00:00Z");

const facts = (over: Partial<AudienceFacts> = {}): AudienceFacts => ({
  country: "US",
  createdAt: new Date("2026-09-01T00:00:00Z"),
  pro: false,
  paid: false,
  lastActiveAt: new Date("2026-09-03T00:00:00Z"),
  storageUsedPercent: 40,
  creditsUsedPercent: 90,
  ...over,
});

describe("audience", () => {
  test("an empty audience admits everyone and needs no facts", () => {
    expect(audienceSchema.parse({})).toEqual(EVERYONE);
    expect(audienceNeeds(EVERYONE).size).toBe(0);
    expect(matchesAudience(EVERYONE, facts({ country: null }), now)).toBe(true);
    expect(describeAudience(EVERYONE)).toBe("everyone");
  });

  test("each rule reads its own fact", () => {
    const needs = audienceNeeds({ ...EVERYONE, plan: "pro", storageUsedPercentAtLeast: 80 });
    expect([...needs].sort()).toEqual(["pro", "storageUsedPercent"]);
  });

  test("countries", () => {
    const gb = { ...EVERYONE, countries: ["GB"] };
    expect(matchesAudience(gb, facts(), now)).toBe(false);
    expect(matchesAudience(gb, facts({ country: "GB" }), now)).toBe(true);
    expect(matchesAudience(gb, facts({ country: null }), now)).toBe(false);
    expect(audienceSchema.safeParse({ countries: ["us"] }).success).toBe(false);
  });

  test("creation window", () => {
    const from = { ...EVERYONE, createdAfter: "2026-09-02T00:00:00.000Z" };
    expect(matchesAudience(from, facts(), now)).toBe(false);
    expect(matchesAudience(from, facts({ createdAt: new Date("2026-09-02T00:00:00Z") }), now)).toBe(true);
    const before = { ...EVERYONE, createdBefore: "2026-09-01T00:00:00.000Z" };
    expect(matchesAudience(before, facts(), now)).toBe(false);
    expect(matchesAudience(before, facts({ createdAt: new Date("2026-08-31T00:00:00Z") }), now)).toBe(true);
  });

  test("plan and paid", () => {
    expect(matchesAudience({ ...EVERYONE, plan: "pro" }, facts(), now)).toBe(false);
    expect(matchesAudience({ ...EVERYONE, plan: "pro" }, facts({ pro: true }), now)).toBe(true);
    expect(matchesAudience({ ...EVERYONE, plan: "free" }, facts({ pro: true }), now)).toBe(false);
    expect(matchesAudience({ ...EVERYONE, paid: "yes" }, facts(), now)).toBe(false);
    expect(matchesAudience({ ...EVERYONE, paid: "yes" }, facts({ paid: true }), now)).toBe(true);
    expect(matchesAudience({ ...EVERYONE, paid: "no" }, facts({ paid: true }), now)).toBe(false);
  });

  test("activity", () => {
    const active = { ...EVERYONE, activeWithinDays: 2 };
    expect(matchesAudience(active, facts(), now)).toBe(true);
    expect(matchesAudience(active, facts({ lastActiveAt: new Date("2026-08-20T00:00:00Z") }), now)).toBe(false);
    expect(matchesAudience(active, facts({ lastActiveAt: null }), now)).toBe(false);
  });

  test("usage thresholds; an unknown usage never matches", () => {
    expect(matchesAudience({ ...EVERYONE, storageUsedPercentAtLeast: 80 }, facts(), now)).toBe(false);
    expect(matchesAudience({ ...EVERYONE, storageUsedPercentAtLeast: 40 }, facts(), now)).toBe(true);
    expect(matchesAudience({ ...EVERYONE, storageUsedPercentAtLeast: 0 }, facts({ storageUsedPercent: null }), now)).toBe(false);
    expect(matchesAudience({ ...EVERYONE, creditsUsedPercentAtLeast: 90 }, facts(), now)).toBe(true);
    expect(matchesAudience({ ...EVERYONE, creditsUsedPercentAtLeast: 95 }, facts(), now)).toBe(false);
  });

  test("rules combine", () => {
    const a = { ...EVERYONE, countries: ["US"], paid: "no" as const, creditsUsedPercentAtLeast: 80 };
    expect(matchesAudience(a, facts(), now)).toBe(true);
    expect(matchesAudience(a, facts({ paid: true }), now)).toBe(false);
    expect(describeAudience(a)).toBe("US · never paid · credits spent ≥ 80%");
  });
});
