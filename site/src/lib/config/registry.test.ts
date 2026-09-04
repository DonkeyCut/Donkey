import { DEFAULT_THRESHOLDS } from "@donkeycut/abexp";
import { describe, expect, test } from "bun:test";

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

  test("the verdict bars ship as the package's defaults", () => {
    const shipped = defaultSettings().experimentResults;
    expect(shipped.graceDays).toBe(30);
    expect(shipped.shipPValue).toBe(DEFAULT_THRESHOLDS.shipPValue);
    expect(shipped.minExposedPerVariant).toBe(DEFAULT_THRESHOLDS.minExposedPerVariant);
  });

  test("a bad override is reported and the default stands", () => {
    const resolved = resolveSettings({ experimentResults: { graceDays: "soon" } }, []);
    expect(resolved.settings.experimentResults).toEqual(SETTINGS.experimentResults.default);
    expect(resolved.invalid).toEqual([{ key: "experimentResults", layer: "override" }]);
  });

  test("an override of one field replaces the whole value", () => {
    const value = { ...SETTINGS.experimentResults.default, shipPValue: 0.1 };
    const resolved = resolveSettings({ experimentResults: value }, []);
    expect(resolved.settings.experimentResults.shipPValue).toBe(0.1);
    expect(resolved.invalid).toEqual([]);
  });
});
