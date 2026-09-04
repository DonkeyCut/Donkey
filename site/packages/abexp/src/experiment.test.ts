import { describe, expect, test } from "bun:test";
import { z } from "zod";

import { canTransition, experimentSchemas, removedAssignedVariants } from "./experiment";
import { defineSettings } from "./settings";

const registry = defineSettings({
  greeting: { schema: z.enum(["short", "long"]), default: "short", public: true, title: "Greeting", description: "" },
  serverOnly: { schema: z.boolean(), default: false, public: false, title: "Server", description: "" },
});

const { experimentSchema } = experimentSchemas(registry);

const valid = {
  key: "copy_v1",
  name: "Welcome copy",
  description: null,
  variants: [
    { key: "control", name: "Control", weight: 50, config: {} },
    { key: "treatment", name: "Treatment", weight: 50, config: { greeting: "long" } },
  ],
  audience: { countries: ["US", "GB"], createdAfter: "2026-09-01T00:00:00.000Z", paid: "no" },
  percent: 100,
  metrics: [
    { key: "purchase", name: "Purchase", source: "purchase", event: null },
    { key: "export", name: "Export", source: "event", event: "export_completed" },
  ],
};

describe("experiment schema", () => {
  test("accepts a well-formed experiment and fills the audience's defaults", () => {
    const parsed = experimentSchema.safeParse(valid);
    expect(parsed.success).toBe(true);
    expect(parsed.data?.audience.plan).toBe("any");
    expect(parsed.data?.audience.activeWithinDays).toBeNull();
  });

  test("rejects repeated variant or metric keys", () => {
    const dup = { ...valid, variants: [valid.variants[0], { ...valid.variants[1], key: "control" }] };
    expect(experimentSchema.safeParse(dup).success).toBe(false);
    const dupMetric = { ...valid, metrics: [valid.metrics[0], { ...valid.metrics[1], key: "purchase" }] };
    expect(experimentSchema.safeParse(dupMetric).success).toBe(false);
  });

  test("rejects weights that add to zero", () => {
    const zero = { ...valid, variants: valid.variants.map((v) => ({ ...v, weight: 0 })) };
    expect(experimentSchema.safeParse(zero).success).toBe(false);
  });

  test("rejects a variant over a server setting, which would never apply", () => {
    const server = { ...valid, variants: [{ ...valid.variants[0], config: { serverOnly: true } }] };
    expect(experimentSchema.safeParse(server).success).toBe(false);
  });

  test("rejects an unknown setting or a bad value in a variant", () => {
    const unknown = { ...valid, variants: [{ ...valid.variants[0], config: { nope: 1 } }] };
    expect(experimentSchema.safeParse(unknown).success).toBe(false);
    const bad = { ...valid, variants: [{ ...valid.variants[0], config: { greeting: "x" } }] };
    expect(experimentSchema.safeParse(bad).success).toBe(false);
  });

  test("an event metric names its event; a purchase metric names none", () => {
    const noEvent = { ...valid, metrics: [{ key: "x", name: "X", source: "event", event: null }] };
    expect(experimentSchema.safeParse(noEvent).success).toBe(false);
    const eventOnPurchase = { ...valid, metrics: [{ key: "x", name: "X", source: "purchase", event: "e" }] };
    expect(experimentSchema.safeParse(eventOnPurchase).success).toBe(false);
  });

  test("rejects a bad audience and an out-of-range percent", () => {
    expect(experimentSchema.safeParse({ ...valid, audience: { countries: ["us"] } }).success).toBe(false);
    expect(experimentSchema.safeParse({ ...valid, audience: { plan: "gold" } }).success).toBe(false);
    expect(experimentSchema.safeParse({ ...valid, percent: 101 }).success).toBe(false);
  });

  test("status transitions", () => {
    expect(canTransition("draft", "running")).toBe(true);
    expect(canTransition("draft", "paused")).toBe(false);
    expect(canTransition("running", "paused")).toBe(true);
    expect(canTransition("paused", "running")).toBe(true);
    expect(canTransition("running", "ended")).toBe(true);
    expect(canTransition("ended", "running")).toBe(false);
  });

  test("an assigned variant cannot be removed", () => {
    const next = experimentSchema.parse({ ...valid, variants: [valid.variants[0]] });
    expect(removedAssignedVariants(next, ["control", "treatment"])).toEqual(["treatment"]);
    expect(removedAssignedVariants(next, ["control"])).toEqual([]);
  });
});
