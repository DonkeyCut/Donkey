import posthog from "posthog-js";
import { useEffect } from "react";

import type { CutMode } from "@/cut/lib/backend/types";
import type { ExportCodec } from "@/cut/lib/exportClient";
import type { PerfLogBatch } from "@/cut/lib/perfLog";
import type { MainThreadSample, PerfSample } from "@/cut/lib/perfTrace";
import type { ShortcutDecline } from "@/cut/lib/shortcutGate";
import type { UpgradeEntry } from "@/cut/lib/upgrade";
import type {
  OnboardingRun,
  ReferralSource,
} from "@/lib/onboarding/sequence";

// What the plans modal opened for: a limit hit, or the plans asked for.
type PlansReason = "projects" | "credits" | "storage" | "plans";

type AuthMode = "sign-in" | "sign-up";
type AuthMethod = "google" | "email";

// What an export was asked for, and who renders it: the tab, or the machine
// behind the project (the engine on this Mac, or the cloud worker).
type ExportShape = {
  residency: CutMode;
  renderer: "tab" | "machine";
  width: number;
  height: number;
  fps: number;
  codec: ExportCodec;
};

// Where a plan's checkout started: the plans modal, with what raised it and
// the button or limit that did; the onboarding's plans slide; or the storage
// grace banner on the projects home.
export type CheckoutOrigin =
  | { surface: "plans_dialog"; reason: PlansReason; entry: UpgradeEntry }
  | { surface: "onboarding" }
  | { surface: "grace_banner" };

// Every product analytics event, in one place. `track` checks the name and
// its properties against this map at compile time, so call sites can't drift
// from the list. Events with `void` properties take no second argument.
export type AnalyticsEvents = {
  // A signed-in app surface finished loading (fires once per page load).
  app_loaded: { app: "cut" | "settings" };
  // Install prompts on the Cut app home's connect gate.
  app_install_clicked: { source: "connect_gate_button" | "connect_gate_link" };
  // A Google or email sign-in/sign-up began on the auth page, and one that
  // came back refused (error is the provider's or the API's code).
  auth_started: { mode: AuthMode; method: AuthMethod };
  auth_failed: { mode: AuthMode; method: AuthMethod; error: string };
  // The welcome sequence a new account sees, and its replay from settings.
  onboarding_started: { source: OnboardingRun };
  // Each slide as it comes up, so the drop between start and finish has a
  // place. step is the slide's index among the ones this account sees.
  onboarding_slide_viewed: { source: OnboardingRun; slide: string; step: number };
  onboarding_referral_selected: {
    referralSources: ReferralSource[];
    referralOther?: string;
  };
  onboarding_completed: { source: OnboardingRun; skipped: boolean; step: number };
  // The sequence's plans slide came up; intro as on the plans modal.
  onboarding_plans_shown: { source: OnboardingRun; intro: number };
  // The first things a new account does in the editor. An import reports
  // once per run of files the person brought in: how many landed, how many
  // didn't, and whether they went on the timeline or only into Media.
  media_imported: { count: number; failed: number; kinds: string[]; target: "timeline" | "media" };
  // A message sent from the chat composer; queued when a turn was running.
  chat_message_sent: { provider: string; attachments: number; queued: boolean };
  // A render started from a generate panel. Chat-started ones ride the chat.
  generation_started: { kind: "video" | "image" | "music" | "voiceover"; refs: number };
  // An export, and how it ended: done when its file is written, queued when
  // the engine or the worker took it on, failed with the error code.
  export_started: ExportShape;
  export_finished: ExportShape & { result: "done" | "queued" | "cancelled" | "failed"; error?: string };
  // Cut projects home.
  project_created: { source: "projects_home" | "sidebar" | "file_import" | "chatgpt_card" };
  folder_created: void;
  // Cut cloud storage limits.
  cut_storage_pill_clicked: void;
  // The top bar's credits pill.
  cut_credits_pill_clicked: { credits: number; dollars: number };
  cut_storage_upgrade_shown: { source: "quota-413" | "render" | "pill" };
  // The plans modal: shown, and closed without a checkout after `seconds` up.
  // entry is the button or limit that raised it; intro is the open discount's
  // percent, 0 for none.
  upgrade_dialog_shown: { reason: PlansReason; entry: UpgradeEntry; pro: boolean; plan: string; intro: number };
  upgrade_dialog_closed: { reason: PlansReason; entry: UpgradeEntry; plan: string; intro: number; seconds: number };
  project_limit_hit: { limit: number };
  cut_grace_banner_shown: void;
  // First exposure to an experiment variant; the same value rides every
  // later event as a super property ($feature/<experiment>).
  experiment_exposed: { experiment: string; variant: string; $set: Record<string, string> };
  // Preview timing from an account that turned diagnostics on, one summary per
  // half minute of playback. Numbers only — see `PerfSample` in the Cut
  // preview's perfTrace for what each one means and why it is here.
  cut_preview_perf: PerfSample;
  // Main-thread freezes from the same account, one summary per half minute
  // that held one — see `MainThreadSample` in perfTrace for the fields.
  cut_main_thread: MainThreadSample;
  // The blocked frames themselves, kept locally and sent at idle, on the page
  // hiding, and on the next open — see perfLog for the record.
  cut_perf_log: PerfLogBatch;
  // A page load where a chord the editor binds went nowhere three times over,
  // held by a text field or a dialog — see shortcutGate. One report per page.
  cut_keyboard_blocked: {
    reason: ShortcutDecline;
    seen: number;
    declined: number;
    key: string;
    tag: string;
    slot: string;
  };
  // The subscribe bonus: shown once when the offer opens, and taken up.
  subscribe_bonus_offered: { dollars: number };
  subscribe_bonus_checkout_started: { dollars: number; minutesLeft: number; source: "editor" | "settings" | "email" };
  // Billing (settings).
  // A plan picked, the checkout that failed to start (error is the API's
  // code), and the trip back from Stripe or an in-place upgrade.
  pro_checkout_started: { plan: string } & CheckoutOrigin;
  pro_checkout_failed: { plan: string; error: string } & CheckoutOrigin;
  checkout_returned: { result: "success" | "cancelled" };
  billing_portal_opened: void;
};

// Binds this browser's events to the signed-in account and records the app
// surface loading. Call from an app shell once the session is known; the
// user id becomes the PostHog distinct id, so every later event carries it.
export function useAppLoaded(
  app: AnalyticsEvents["app_loaded"]["app"],
  user: { id: string; email?: string } | undefined,
): void {
  const { id, email } = user ?? {};
  useEffect(() => {
    if (!id) return;
    posthog.identify(id, email ? { email } : undefined);
    track("app_loaded", { app });
  }, [app, id, email]);
}

// Forgets the signed-out account on this browser, so whatever happens here
// next counts as an anonymous visitor until the next sign-in binds one.
export function resetAnalytics(): void {
  posthog.reset();
}

// Runs once per page load, after `identify`: every assignment becomes a super
// property so any later event breaks down by variant, and a first exposure is
// its own event with the variant pinned on the person. A property registered
// on an earlier visit is dropped when the account no longer holds that
// experiment, so an ended one stops tagging events.
const REGISTERED_KEY = "dk-experiment-features";
let exposuresReported = false;

function readRegistered(): string[] {
  try {
    const raw = window.localStorage.getItem(REGISTERED_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed.filter((k): k is string => typeof k === "string") : [];
  } catch {
    return [];
  }
}

export function reportExposures(config: { experiments: Record<string, string>; exposed: string[] }): void {
  if (exposuresReported) return;
  exposuresReported = true;
  const keys = Object.keys(config.experiments);
  const features: Record<string, string> = {};
  for (const [key, variant] of Object.entries(config.experiments)) features[`$feature/${key}`] = variant;
  for (const stale of readRegistered()) {
    if (!keys.includes(stale)) posthog.unregister(`$feature/${stale}`);
  }
  try {
    window.localStorage.setItem(REGISTERED_KEY, JSON.stringify(keys));
  } catch {
    // A browser that refuses storage still reports this load correctly.
  }
  if (keys.length) posthog.register(features);
  for (const key of config.exposed) {
    const variant = config.experiments[key];
    if (!variant) continue;
    track("experiment_exposed", { experiment: key, variant, $set: { [`experiment_${key}`]: variant } });
  }
}

export function track<Name extends keyof AnalyticsEvents>(
  name: Name,
  ...props: AnalyticsEvents[Name] extends void
    ? []
    : [properties: AnalyticsEvents[Name]]
): void {
  posthog.capture(name, (props as [Record<string, unknown>?])[0]);
}
