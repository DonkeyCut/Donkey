import {
  DEFAULT_THRESHOLDS,
  defaultSettings as defaultsOf,
  defineSettings,
  publicSettingKeys,
  settingKeys,
  type PublicKeyOf,
  type PublicSettingsOf,
  type SettingsOf,
} from "@donkeycut/abexp";
import { z } from "zod";
import { creditOfferTermsSchema } from "@/lib/credits/offerTerms";
import { DEFAULT_EMAIL_PRIORITIES, EMAIL_KIND_IDS } from "@/lib/email/kindIds";

import { maxCreditGrantDollars, maxCreditGrantExpiryDays } from "@/lib/credits/top-up";

// The settings registry: every runtime tunable the product has, declared once
// with a schema and a default. A value resolves default < override < variant
// (src/lib/config/resolve.ts); su edits the override, an experiment supplies
// the variant. Client-safe: zod only, so the su forms read the same
// declarations the server validates against. A feature that people might
// tune ships its setting here in the same change.

function validTimeZone(zone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

export const SETTINGS = defineSettings({
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
  promotionCreditOffer: {
    schema: creditOfferTermsSchema.extend({ minimumAccountAgeDays: z.number().int().min(1).max(36500) }).strict(),
    default: { dollars: 15, claimWindowDays: 3, expiresAfterDays: 28, claim: "link", minimumAccountAgeDays: 7 },
    public: false,
    title: "Promotion credit offer",
    description: "Default credit offer and minimum account age for new promotion drafts. Saved drafts keep their terms.",
  },
  chatRuntime: {
    schema: z.object({
      syncIntervalMs: z.number().int().min(1000).max(30000),
      sceneLeaseMs: z.number().int().min(15000).max(120000),
      journalBytes: z.number().int().min(1048576).max(33554432),
    }).strict(),
    default: { syncIntervalMs: 5000, sceneLeaseMs: 30000, journalBytes: 8388608 },
    public: true,
    title: "Chat continuity",
    description: "Project and conversation refresh cadence, scene ownership expiry, and saved engine transcript size.",
  },
  cutJudge: {
    schema: z
      .object({
        // Preload the skill the judge picks for the turn; off leaves the model
        // to read skills on its own.
        skillSuggestion: z.boolean(),
        // The reference-need probability below which no skill is attached.
        skillGate: z.number().min(0).max(1),
        // The winning skill's own fit below which it is dropped.
        skillFits: z.number().min(0).max(1),
        // Declare only the tool areas the judge routes to; off declares the
        // whole catalog on every turn.
        toolRouting: z.boolean(),
        // An area's probability at or above which its tools are declared.
        toolArea: z.number().min(0).max(1),
        // How long the first model round waits for the judge before going out
        // with the full catalog and no skill. Set above the judgment's slowest
        // turns: a round that goes out early is the one a chat or complex
        // verdict then throws away.
        judgeWaitMs: z.number().int().min(0).max(4000),
        // A stock candidate's fit below which it is left out of a search.
        stockFit: z.number().min(0).max(1),
        // A transcript word's disfluency probability at or above which
        // find_filler reports it.
        fillerCut: z.number().min(0).max(1),
        // The confidence below which a described voice falls back to the default.
        voicePick: z.number().min(0).max(1),
        // How often a running turn re-places the messages waiting in the tray
        // against the work it has done since; 0 places them once, at send.
        queueRetriageMs: z.number().int().min(0).max(60000),
        // Run a turn the judgment settles to one known action with no model
        // round at all; off sends every turn through the chat loop.
        instantAction: z.boolean(),
        // The chosen action's own probability below which the turn takes the
        // loop instead. The floors below do the same for each argument.
        instantFloor: z.number().min(0).max(1),
        instantTarget: z.number().min(0).max(1),
        instantEnum: z.number().min(0).max(1),
        // A style, look or direction the request left open: several good
        // answers split the probability, so the winner clears less.
        instantPick: z.number().min(0).max(1),
        instantLevel: z.number().min(0).max(1),
        // A yes/no argument has to be this decisive in one direction.
        instantBool: z.number().min(0.5).max(1),
        // An ask that names an exact figure, acts on more than one item,
        // leaves a second edit undone, or wants the shot itself remade goes
        // to the model at or above these.
        instantExact: z.number().min(0).max(1),
        instantMulti: z.number().min(0).max(1),
        instantLeftover: z.number().min(0).max(1),
        instantRemake: z.number().min(0).max(1),
        // A candidate's fit below which a described sweep leaves it out.
        sweepFit: z.number().min(0).max(1),
        // Judge the turn's own work before it closes; off lets a turn sign
        // off on whatever it did.
        qualityGate: z.boolean(),
        // The probabilities below which the work is judged unfinished, the
        // footage under-watched, and the reply wider than the record.
        qualityFinished: z.number().min(0).max(1),
        qualitySeen: z.number().min(0).max(1),
        qualityHonest: z.number().min(0).max(1),
        // The probability above which the ask is taken to turn on how the
        // source sounds, which makes unplayed seconds a gap worth a round.
        qualityHears: z.number().min(0).max(1),
        // The probability above which on-screen text is taken to be the
        // source's own narration, which puts its words in the transcript and
        // leaves only their treatment to be read off the frames.
        qualityCaptionsSpeak: z.number().min(0).max(1),
        // Seconds of close reading that settle how a spoken caption track is
        // set, once the words are known from the transcript.
        qualityTreatmentSeconds: z.number().min(0).max(120),
        // How many times one turn may be sent back to work by the gate.
        qualityRounds: z.number().int().min(0).max(6),
      })
      .strict(),
    default: {
      skillSuggestion: true,
      skillGate: 0.4,
      skillFits: 0.3,
      toolRouting: true,
      toolArea: 0.2,
      judgeWaitMs: 1000,
      stockFit: 0.5,
      fillerCut: 0.5,
      voicePick: 0.4,
      queueRetriageMs: 4000,
      instantAction: true,
      instantFloor: 0.5,
      instantTarget: 0.5,
      instantEnum: 0.5,
      instantPick: 0.15,
      instantLevel: 0.3,
      instantBool: 0.7,
      instantExact: 0.4,
      instantMulti: 0.4,
      instantLeftover: 0.5,
      instantRemake: 0.3,
      sweepFit: 0.5,
      qualityGate: true,
      qualityFinished: 0.5,
      qualitySeen: 0.5,
      qualityHonest: 0.5,
      qualityHears: 0.6,
      qualityCaptionsSpeak: 0.7,
      qualityTreatmentSeconds: 8,
      qualityRounds: 3,
    },
    public: true,
    title: "Chat judgments",
    description:
      "Thresholds for the typed judgments that route a chat turn (skill, tool areas), run a one-action turn with no model round, hold a turn back until its work is finished and its reply true to it, re-place the messages waiting in the tray, pick the items a sweep touches, rank stock, find filler words, and resolve described voices.",
  },
  cutClip: {
    schema: z
      .object({
        // A pause this long ends a sentence when the punctuation does not.
        pauseBreakSeconds: z.number().min(0.1).max(5),
        // What a clip may run. The sweep aims at the target and accepts
        // anything between the bounds, ending on a sentence.
        minSeconds: z.number().min(3).max(600),
        targetSeconds: z.number().min(3).max(600),
        maxSeconds: z.number().min(3).max(600),
        // How far apart the wide sweep's candidate starts sit. Smaller reads
        // more of the source and costs more questions.
        strideSeconds: z.number().min(1).max(120),
        // How many of the sweep's best earn the close read.
        shortlist: z.number().int().min(1).max(60),
        // Standing alone and landing are requirements: a stretch that needs
        // what came before it, or that trails off into the next thing, is not
        // a clip however well it opens. Below either floor it is not offered.
        standaloneFloor: z.number().min(0).max(1),
        payoffFloor: z.number().min(0).max(1),
        // What orders the ones that qualify.
        standaloneWeight: z.number().min(0).max(1),
        hookWeight: z.number().min(0).max(1),
        payoffWeight: z.number().min(0).max(1),
        // The composite below which a moment is not offered at all.
        rankFloor: z.number().min(0).max(1),
        // Second beats considered per clip, and the probability one has to
        // reach to be cut in behind the first.
        pairsPerClip: z.number().int().min(0).max(10),
        followsFloor: z.number().min(0).max(1),
      })
      .strict(),
    default: {
      pauseBreakSeconds: 0.6,
      minSeconds: 18,
      targetSeconds: 45,
      maxSeconds: 75,
      strideSeconds: 12,
      shortlist: 14,
      standaloneFloor: 0.35,
      payoffFloor: 0.5,
      standaloneWeight: 0.4,
      hookWeight: 0.35,
      payoffWeight: 0.25,
      rankFloor: 0.45,
      pairsPerClip: 3,
      followsFloor: 0.6,
    },
    public: true,
    title: "Clipping a long source",
    description:
      "How a talk or an interview is read for the moments worth cutting a short from: what a clip may run, how widely the first sweep looks, how many moments earn the close read, and what the ranking weighs.",
  },
  experimentResults: {
    schema: z
      .object({
        // An ended experiment keeps getting a fresh read for this long, so
        // late conversions still land in it.
        graceDays: z.number().int().min(0).max(365),
        // The sample a positive result is believed on.
        minExposedPerVariant: z.number().int().min(1),
        minConversions: z.number().int().min(1),
        // The smaller sample a loss can be called on.
        earlyMinExposed: z.number().int().min(1),
        earlyMinConversions: z.number().int().min(1),
        shipPValue: z.number().min(0).max(1),
        stopProbability: z.number().min(0).max(1),
        // The lift the sample-size estimate plans for.
        plannedRelativeLift: z.number().min(0.01).max(10),
      })
      .strict(),
    default: {
      graceDays: 30,
      minExposedPerVariant: DEFAULT_THRESHOLDS.minExposedPerVariant,
      minConversions: DEFAULT_THRESHOLDS.minConversions,
      earlyMinExposed: DEFAULT_THRESHOLDS.earlyMinExposed,
      earlyMinConversions: DEFAULT_THRESHOLDS.earlyMinConversions,
      shipPValue: DEFAULT_THRESHOLDS.shipPValue,
      stopProbability: DEFAULT_THRESHOLDS.stopProbability,
      plannedRelativeLift: DEFAULT_THRESHOLDS.plannedRelativeLift,
    },
    public: false,
    title: "Experiment results",
    description:
      "The bars a verdict is called against, and how long an ended experiment keeps being recomputed.",
  },
  signupCredits: {
    schema: z
      .object({
        // USD the signup hook grants a new account; 0 grants nothing.
        dollars: z.number().int().min(0).max(maxCreditGrantDollars),
        // Days the grant stays spendable; null keeps it forever.
        expiresAfterDays: z.number().int().min(1).max(maxCreditGrantExpiryDays).nullable(),
      })
      .strict(),
    default: { dollars: 0, expiresAfterDays: 7 },
    public: false,
    title: "Signup credits",
    description: "USD a new account is granted at signup, and how many days the grant lives.",
  },
  emailSendBudget: {
    schema: z
      .object({
        // Emails the provider's plan includes per billing cycle.
        monthlyAllowance: z.number().int().min(1).max(10_000_000),
        // Day of the month the plan renews, at UTC midnight.
        renewalDay: z.number().int().min(1).max(31),
        // Slots kept free per work day for emails sent by hand, held for
        // every work day left in the cycle.
        manualReserve: z.number().int().min(0).max(100000),
        manualTimeZone: z.string().refine(validTimeZone, "Unknown IANA time zone"),
        // Work hours in that zone, start inclusive and end exclusive.
        manualStartHour: z.number().int().min(0).max(23),
        manualEndHour: z.number().int().min(1).max(24),
        manualWeekdaysOnly: z.boolean(),
        // Days of signup history the transactional forecast averages over.
        signupLookbackDays: z.number().int().min(1).max(90),
        // Slots kept free beyond the forecast for transactional email the
        // forecast cannot see, such as credit offers sent by hand.
        transactionalHeadroom: z.number().int().min(0).max(1_000_000),
      })
      .strict()
      .refine((v) => v.manualStartHour < v.manualEndHour, { message: "Work hours must end after they start." })
      // A cycle holds at most 31 work days, so this keeps every ceiling above zero.
      .refine((v) => v.manualReserve * 31 + v.transactionalHeadroom < v.monthlyAllowance, {
        message: "The reserves must leave room for bulk sends over a 31-day cycle.",
      }),
    default: {
      monthlyAllowance: 50000,
      renewalDay: 11,
      manualReserve: 10,
      manualTimeZone: "Asia/Seoul",
      manualStartHour: 9,
      manualEndHour: 18,
      manualWeekdaysOnly: true,
      signupLookbackDays: 7,
      transactionalHeadroom: 200,
    },
    public: false,
    title: "Email send budget",
    description:
      "The plan's monthly allowance and renewal day, the slots held per work day for emails sent by hand, and how the transactional forecast that holds slots ahead of promotions is sized.",
  },
  emailPriorities: {
    schema: z
      // A kind added after the override was saved reads its default, so the
      // saved order for the rest keeps holding.
      .object(
        Object.fromEntries(
          EMAIL_KIND_IDS.map((id) => [id, z.number().int().min(0).max(1000).default(DEFAULT_EMAIL_PRIORITIES[id])]),
        ),
      )
      .strict(),
    default: { ...DEFAULT_EMAIL_PRIORITIES },
    public: false,
    title: "Email priorities",
    description: "The order the outbox sends in when the budget is short: higher goes first. A change applies to emails queued from then on.",
  },
  creditExpiryNotice: {
    schema: z
      .object({
        // How many days before a given grant expires its account is emailed.
        daysBefore: z.number().int().min(1).max(maxCreditGrantExpiryDays),
      })
      .strict(),
    default: { daysBefore: 3 },
    public: false,
    title: "Credit expiry notice",
    description: "How many days before signup or manually granted credits expire the account is emailed.",
  },
  manualCreditOffer: {
    schema: z
      .object({
        // Days the emailed claim link stays open after it is sent.
        claimWindowDays: z.number().int().min(1).max(365),
      })
      .strict(),
    default: { claimWindowDays: 3 },
    public: false,
    title: "Manual credit offer",
    description: "How many days the claim link in a credit offer email stays open.",
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
});

// The settings su shows on its Product tab: what an account gets. The
// settings tab under Experiments still lists every key.
export const PRODUCT_SETTING_KEYS = ["signupCredits", "creditExpiryNotice", "manualCreditOffer", "promotionCreditOffer", "subscribeBonus", "proAllowancePromotion"] as const satisfies readonly SettingKey[];

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
