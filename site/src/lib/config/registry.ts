import {
  defaultSettings as defaultsOf,
  defineSettings,
  publicSettingKeys,
  settingKeys,
  type PublicKeyOf,
  type PublicSettingsOf,
  type SettingsOf,
} from "@donkeycut/abexp";
import { z } from "zod";

import { maxCreditGrantDollars, maxCreditGrantExpiryDays } from "@/lib/credits/top-up";

// One paid plan's terms in the planTerms setting (src/lib/billing/plans.ts).
const planTermsSchema = z
  .object({
    monthlyDollars: z.number().multipleOf(0.01).min(0.5).max(10_000),
    monthlyCredits: z.number().int().min(0).max(10_000_000),
    storageGb: z.number().int().min(1).max(100_000),
    rendersPerDay: z.number().int().min(1).max(100_000),
    unlimitedProjects: z.boolean(),
  })
  .strict();

// The settings registry: every lever su runs, declared once
// with a schema and a default. A value resolves default < override < variant
// (src/lib/config/resolve.ts); a database row holds the override, an
// experiment supplies the variant. Client-safe: zod only, so a form reads the
// same declarations the server validates against. An engineering threshold is a
// constant beside its code.

export const SETTINGS = defineSettings({
  databasePool: {
    schema: z.object({
      maxConnections: z.number().int().min(1).max(20),
      idleTimeoutMs: z.number().int().min(100).max(30000),
      connectionTimeoutMs: z.number().int().min(100).max(30000),
    }).strict(),
    default: { maxConnections: 3, idleTimeoutMs: 5000, connectionTimeoutMs: 5000 },
    public: false,
    title: "Database connection pool",
    description: "Connections per server instance, idle connection lifetime, and connection wait limit. Instances start with defaults and apply overrides whenever they read settings. Existing connections drain at their idle deadline.",
  },
  chatgptApp: {
    schema: z.object({
      enabled: z.boolean(),
      issuer: z.url().pipe(z.string().refine((v) => new URL(v).protocol === "https:" && new URL(v).origin === v)),
      redirectUris: z.array(z.url().pipe(z.string().refine((v) => new URL(v).protocol === "https:" && !new URL(v).hash))).min(1),
      accessSeconds: z.number().int().min(60).max(3600),
      refreshDays: z.number().int().min(1).max(90),
      requestsPerMinute: z.number().int().min(10).max(600),
      oauthRequestsPerIpMinute: z.number().int().min(10).max(10000).default(600),
      pollMs: z.number().int().min(1000).max(30000),
      // How long a tool call waits on the batch before handing back a job id.
      commandWaitMs: z.number().int().min(5000).max(240000).default(50000),
      // How long a batch waits for the editor in the card to claim it before
      // the call answers that no card has the project open.
      editorClaimMs: z.number().int().min(500).max(30000).default(3000),
      // How long the editor stays signed in inside the ChatGPT card.
      editorSessionHours: z.number().int().min(1).max(72).default(12),
    }).strict(),
    default: { enabled: false, issuer: "https://donkeycut.com", redirectUris: ["https://chatgpt.com/connector_platform_oauth_redirect"], accessSeconds: 3600, refreshDays: 30, requestsPerMinute: 120, oauthRequestsPerIpMinute: 600, pollMs: 2000, commandWaitMs: 50000, editorClaimMs: 3000, editorSessionHours: 12 },
    public: false,
    title: "ChatGPT app",
    description: "Account linking, allowed OAuth callbacks, token lifetimes, preview polling, how long an edit call waits and how long the card's editor has to claim it, and how long the editor stays signed in inside the card. Enable after the OAuth tables are deployed.",
  },
  cutPreviewJobs: {
    schema: z.object({ maxAttempts: z.number().int().min(1).max(10) }).strict(),
    default: { maxAttempts: 5 },
    public: false,
    title: "Cloud preview queue",
    description: "Maximum attempts when concurrent preview submissions conflict.",
  },
  cutStorageTransactions: {
    schema: z.object({ maxAttempts: z.number().int().min(1).max(10) }).strict(),
    default: { maxAttempts: 5 },
    public: false,
    title: "Cut storage transactions",
    description: "Maximum attempts for storage accounting transactions that encounter a database write conflict.",
  },
  librarySharing: {
    schema: z.object({ pageSize: z.number().int().min(10).max(100) }).strict(),
    default: { pageSize: 40 },
    public: false,
    title: "Shared library",
    description: "Folders, assets, and templates returned per shared library page.",
  },
  factCheck: {
    schema: z
      .object({
        // Searches run side by side, this many at a time.
        concurrency: z.number().int().min(1).max(10),
        // A verdict other than unverifiable needs at least this many sources.
        minSources: z.number().int().min(1).max(5),
        maxSourcesPerClaim: z.number().int().min(1).max(10),
      })
      .strict(),
    default: { concurrency: 4, minSources: 2, maxSourcesPerClaim: 5 },
    public: false,
    title: "Fact check",
    description:
      "How claims are checked against the web: how many searches run at once, how many sources a verdict needs, and how many sources each claim reports.",
  },
  cutProxy: {
    schema: z
      .object({
        // A heavy video's light proxy: its bitrate ceiling at the 1080p cap,
        // kbit/s, so a fast cut streams it from the cloud in time.
        lightKbps: z.number().int().min(500).max(50_000),
        // How long a master ffmpeg could not make a proxy from keeps the
        // cloud from trying again, hours.
        retryAfterHours: z.number().min(0).max(24 * 30),
      })
      .strict(),
    default: { lightKbps: 6000, retryAfterHours: 24 },
    public: false,
    title: "Preview proxies",
    description:
      "The light proxy's bitrate ceiling for heavy cloud videos, and how long a master that could not be proxied waits before the cloud tries it again.",
  },
  signupCredits: {
    schema: z
      .object({
        // USD the signup hook grants a new account, to the cent; 0 grants
        // nothing. People see it as credits: 0.5 → 500 credits.
        dollars: z.number().multipleOf(0.01).min(0).max(maxCreditGrantDollars),
        // Days the grant stays spendable; null keeps it forever.
        expiresAfterDays: z.number().int().min(1).max(maxCreditGrantExpiryDays).nullable(),
      })
      .strict(),
    default: { dollars: 0, expiresAfterDays: 7 },
    public: false,
    title: "Signup credits",
    description: "USD a new account is granted at signup, shown as 1,000 credits per dollar, and how many days the grant lives.",
  },
  signupCreditsPerNetwork: {
    schema: z
      .object({
        // Signup grants one network takes per window; later accounts from it
        // start with no credits.
        limit: z.number().int().min(1).max(1000),
        // Days a network's window runs from its first grant.
        windowDays: z.number().int().min(1).max(365),
      })
      .strict(),
    default: { limit: 3, windowDays: 7 },
    public: false,
    title: "Signup credits per network",
    description: "How many new accounts from one network get the signup credits within the window; later accounts from it start with none.",
  },
  subscribeBonus: {
    schema: z
      .object({
        // USD granted for subscribing to Pro while the offer is open; 0 makes
        // no offer.
        dollars: z.number().int().min(0).max(maxCreditGrantDollars),
        // Share of the signup grant spent before the offer opens.
        spentPercent: z.number().int().min(1).max(100),
        // Hours the offer stays open once the app has shown it.
        windowHours: z.number().int().min(1).max(24 * 30),
        // The last UTC day the bonus credit is spendable (YYYY-MM-DD); null
        // keeps it forever.
        creditsExpireOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "YYYY-MM-DD").nullable(),
      })
      .strict(),
    default: { dollars: 0, spentPercent: 50, windowHours: 24, creditsExpireOn: null },
    public: true,
    title: "Subscribe bonus",
    description:
      "Credit offered to an account that has spent this share of its signup grant, for subscribing to Pro within the window. The credit is spendable through the last day.",
  },
  proAllowancePromotion: {
    schema: z
      .object({
        // Multiplies the AI allowance a Pro billing period starts with; 1 is
        // the plain plan.
        multiplier: z.number().int().min(1).max(20),
        // The last UTC day a period may start on and still get the multiplier
        // (YYYY-MM-DD); null keeps it on for every period.
        lastDay: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "YYYY-MM-DD").nullable(),
      })
      .strict(),
    default: { multiplier: 1, lastDay: null },
    public: true,
    title: "Pro allowance promotion",
    description:
      "Multiplies the AI allowance a Pro billing period starts with, for periods that start on or before the last day. Later periods start with the plain allowance.",
  },
  proEndingNotice: {
    schema: z
      .object({
        // The editor's top bar shows the days left once fewer than this many
        // remain before a cancelled Pro plan ends.
        daysBefore: z.number().int().min(1).max(365),
      })
      .strict(),
    default: { daysBefore: 14 },
    public: true,
    title: "Pro ending notice",
    description:
      "How many days before a cancelled Pro plan ends the editor starts showing the days left. Until then a plan set to cancel looks like one that renews.",
  },
  introOffer: {
    schema: z
      .object({
        // Percent off the Pro price; 0 makes no offer.
        percentOff: z.number().int().min(0).max(90),
        // Billing months the discount covers.
        months: z.number().int().min(1).max(12),
        // Hours the offer stays open after the account first sees it.
        windowHours: z.number().int().min(1).max(24 * 30),
      })
      .strict(),
    default: { percentOff: 0, months: 1, windowHours: 24 },
    public: true,
    title: "Intro offer",
    description:
      "A discount on the first months of Pro for an account that has never held a plan. It opens the first time the account sees it and closes this many hours later, for good. Checkout applies it on its own.",
  },
  freeProjectLimit: {
    schema: z
      .object({
        // Projects a free account may hold besides its starter; null is no limit.
        projects: z.number().int().min(0).max(1000).nullable(),
      })
      .strict(),
    default: { projects: null },
    public: true,
    title: "Free project limit",
    description:
      "How many projects a free account may hold besides its starter project. Creating one more opens the upgrade dialog.",
  },
  planTerms: {
    schema: z.object({ plus: planTermsSchema, pro: planTermsSchema, max: planTermsSchema }).strict(),
    default: {
      plus: { monthlyDollars: 5, monthlyCredits: 5_000, storageGb: 10, rendersPerDay: 10, unlimitedProjects: false },
      pro: { monthlyDollars: 20, monthlyCredits: 20_000, storageGb: 100, rendersPerDay: 200, unlimitedProjects: true },
      max: { monthlyDollars: 49, monthlyCredits: 60_000, storageGb: 500, rendersPerDay: 500, unlimitedProjects: true },
    },
    public: true,
    title: "Plan terms",
    description:
      "What each paid plan sells: its monthly USD price, which has to match its Stripe price, the AI credits each period starts with, cloud storage, renders a day, and whether the free project limit is lifted. Credits cost about 0.77 of their face value when spent in full.",
  },
  planPrices: {
    schema: z
      .object({
        // Each paid plan's recurring monthly Stripe price; null leaves the
        // plan unsold.
        plus: z.string().regex(/^price_/, "price_…").nullable(),
        pro: z.string().regex(/^price_/, "price_…").nullable(),
        max: z.string().regex(/^price_/, "price_…").nullable(),
      })
      .strict(),
    default: { plus: null, pro: null, max: null },
    public: false,
    title: "Plan prices",
    description:
      "The Stripe price each paid plan checks out with. A plan without one can't be bought, and a subscription to a price not listed here is no plan.",
  },
});

export type SettingKey = keyof typeof SETTINGS;
export type Settings = SettingsOf<typeof SETTINGS>;
export type PublicSettingKey = PublicKeyOf<typeof SETTINGS>;
export type PublicSettings = PublicSettingsOf<typeof SETTINGS>;

export const SETTING_KEYS = settingKeys(SETTINGS);
export const PUBLIC_SETTING_KEYS = publicSettingKeys(SETTINGS);

export const isSettingKey = (key: string): key is SettingKey => key in SETTINGS;

export function defaultSettings(): Settings {
  return defaultsOf(SETTINGS);
}
