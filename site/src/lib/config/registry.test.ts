import { describe, expect, test } from "bun:test";

import type { PlanTerms } from "@/lib/billing/plans";

import { PUBLIC_SETTING_KEYS, SETTINGS, SETTING_KEYS, defaultSettings } from "./registry";
import { publicSubset, resolveSettings } from "./resolve";

describe("the product's settings registry", () => {
  test("every default parses against its schema", () => {
    for (const key of SETTING_KEYS) {
      expect(SETTINGS[key].schema.safeParse(SETTINGS[key].default).success).toBe(true);
    }
  });

  test("the public subset carries only public keys", () => {
    expect(Object.keys(publicSubset(defaultSettings())).sort()).toEqual([...PUBLIC_SETTING_KEYS].sort());
  });

  test("a bad override is reported and the default stands", () => {
    const resolved = resolveSettings({ databasePool: { maxConnections: "many" } }, []);
    expect(resolved.settings.databasePool).toEqual(SETTINGS.databasePool.default);
    expect(resolved.invalid).toEqual([{ key: "databasePool", layer: "override" }]);
  });

  test("plan terms saved before local prices read the default ones", () => {
    const { plus, pro, max } = SETTINGS.planTerms.default;
    const strip = ({ localPrices: _, ...rest }: PlanTerms) => rest;
    const resolved = resolveSettings({ planTerms: { plus: strip(plus), pro: strip(pro), max: strip(max) } }, []);
    expect(resolved.invalid).toEqual([]);
    expect(resolved.settings.planTerms.pro.localPrices).toEqual(pro.localPrices);
  });

  test("the signup grant is set to the cent", () => {
    // Cents are the smallest step su can set: 0.5 is 500 credits, and a stored
    // whole-dollar override keeps parsing.
    const schema = SETTINGS.signupCredits.schema;
    for (const dollars of [0, 0.07, 0.29, 0.5, 3]) {
      expect(schema.safeParse({ dollars, expiresAfterDays: 7 }).success).toBe(true);
    }
    expect(schema.safeParse({ dollars: 0.005, expiresAfterDays: 7 }).success).toBe(false);
  });

  test("an override of one field replaces the whole value", () => {
    const value = { ...SETTINGS.databasePool.default, maxConnections: 5 };
    const resolved = resolveSettings({ databasePool: value }, []);
    expect(resolved.settings.databasePool.maxConnections).toBe(5);
    expect(resolved.invalid).toEqual([]);
  });
});
