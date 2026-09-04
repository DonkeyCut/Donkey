import { z } from "zod";

// Who an experiment can enrol. An audience is a set of rules over facts about
// the account; every rule is optional and an empty audience admits everyone.
// Adding a rule means a field here, a fact in `AudienceFacts`, a line in
// `matchesAudience`, and the query that collects the fact
// (src/lib/config/audienceFacts.ts). Client-safe: zod only.

const alpha2 = z.string().regex(/^[A-Z]{2}$/, "Upper-case alpha-2 codes.");

export const audienceSchema = z
  .object({
    // Where the assigning request came from; empty admits every country.
    countries: z.array(alpha2).max(250).default([]),
    // Account creation window; either edge may be open.
    createdAfter: z.iso.datetime().nullable().default(null),
    createdBefore: z.iso.datetime().nullable().default(null),
    // Whether the account holds an active Pro subscription.
    plan: z.enum(["any", "free", "pro"]).default("any"),
    // Whether the account has ever paid for anything.
    paid: z.enum(["any", "yes", "no"]).default("any"),
    // A session touched within this many days.
    activeWithinDays: z.number().int().min(1).max(365).nullable().default(null),
    // Share of the cloud storage quota in use, at least this much.
    storageUsedPercentAtLeast: z.number().min(0).max(100).nullable().default(null),
    // Share of every credit ever granted that has been spent, at least this much.
    creditsUsedPercentAtLeast: z.number().min(0).max(100).nullable().default(null),
  })
  .strict();

export type Audience = z.output<typeof audienceSchema>;
export type AudienceInput = z.input<typeof audienceSchema>;

export const EVERYONE: Audience = audienceSchema.parse({});

export type AudienceFacts = {
  country: string | null;
  createdAt: Date;
  pro: boolean;
  paid: boolean;
  lastActiveAt: Date | null;
  // null when the account has no quota (unlimited) or the fact was not needed.
  storageUsedPercent: number | null;
  creditsUsedPercent: number | null;
};

export type AudienceFact = keyof AudienceFacts;

/** The facts an audience's rules read; the collector fetches only those. */
export function audienceNeeds(audience: Audience): Set<AudienceFact> {
  const needs = new Set<AudienceFact>();
  if (audience.countries.length > 0) needs.add("country");
  if (audience.createdAfter || audience.createdBefore) needs.add("createdAt");
  if (audience.plan !== "any") needs.add("pro");
  if (audience.paid !== "any") needs.add("paid");
  if (audience.activeWithinDays !== null) needs.add("lastActiveAt");
  if (audience.storageUsedPercentAtLeast !== null) needs.add("storageUsedPercent");
  if (audience.creditsUsedPercentAtLeast !== null) needs.add("creditsUsedPercent");
  return needs;
}

export function matchesAudience(audience: Audience, facts: AudienceFacts, now: Date): boolean {
  if (audience.countries.length > 0) {
    if (!facts.country || !audience.countries.includes(facts.country)) return false;
  }
  if (audience.createdAfter && facts.createdAt.getTime() < Date.parse(audience.createdAfter)) return false;
  if (audience.createdBefore && facts.createdAt.getTime() >= Date.parse(audience.createdBefore)) return false;
  if (audience.plan === "pro" && !facts.pro) return false;
  if (audience.plan === "free" && facts.pro) return false;
  if (audience.paid === "yes" && !facts.paid) return false;
  if (audience.paid === "no" && facts.paid) return false;
  if (audience.activeWithinDays !== null) {
    const since = now.getTime() - audience.activeWithinDays * 86_400_000;
    if (!facts.lastActiveAt || facts.lastActiveAt.getTime() < since) return false;
  }
  if (audience.storageUsedPercentAtLeast !== null) {
    if (facts.storageUsedPercent === null || facts.storageUsedPercent < audience.storageUsedPercentAtLeast) {
      return false;
    }
  }
  if (audience.creditsUsedPercentAtLeast !== null) {
    if (facts.creditsUsedPercent === null || facts.creditsUsedPercent < audience.creditsUsedPercentAtLeast) {
      return false;
    }
  }
  return true;
}

/** One line for a list: the rules an audience sets. */
export function describeAudience(audience: Audience): string {
  const parts: string[] = [];
  if (audience.countries.length) parts.push(audience.countries.join(", "));
  if (audience.createdAfter) parts.push(`created from ${audience.createdAfter.slice(0, 10)}`);
  if (audience.createdBefore) parts.push(`created before ${audience.createdBefore.slice(0, 10)}`);
  if (audience.plan !== "any") parts.push(audience.plan === "pro" ? "Pro" : "no Pro");
  if (audience.paid !== "any") parts.push(audience.paid === "yes" ? "has paid" : "never paid");
  if (audience.activeWithinDays !== null) parts.push(`active within ${audience.activeWithinDays}d`);
  if (audience.storageUsedPercentAtLeast !== null) {
    parts.push(`storage ≥ ${audience.storageUsedPercentAtLeast}%`);
  }
  if (audience.creditsUsedPercentAtLeast !== null) {
    parts.push(`credits spent ≥ ${audience.creditsUsedPercentAtLeast}%`);
  }
  return parts.length ? parts.join(" · ") : "everyone";
}
