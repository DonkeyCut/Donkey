import posthog from "posthog-js";
import { useEffect } from "react";

// Every product analytics event, in one place. `track` checks the name and
// its properties against this map at compile time, so call sites can't drift
// from the list. Events with `void` properties take no second argument.
export type AnalyticsEvents = {
  // A signed-in app surface finished loading (fires once per page load).
  app_loaded: { app: "cut" | "settings" };
  // Landing page download CTAs.
  home_download_clicked: { location: "hero" | "final_cta" };
  // Install prompts on the Cut app home's connect gate.
  app_install_clicked: { source: "connect_gate_button" | "connect_gate_link" };
  // Cut cloud mode turned on (the cut-web-mode account flag).
  cut_cloud_enable_clicked: {
    source:
      | "connect_gate_install"
      | "connect_gate_ask"
      | "connect_gate_blocked"
      | "settings_flags";
  };
  // Cut projects home.
  project_created: { source: "projects_home" | "sidebar" | "file_import" };
  folder_created: void;
  // Cut cloud storage limits.
  cut_storage_pill_clicked: void;
  cut_storage_upgrade_shown: { source: "quota-413" | "pill" };
  cut_grace_banner_shown: void;
  // Billing (settings).
  pro_checkout_started: void;
  billing_portal_opened: void;
  credits_checkout_started: { amountDollars: number };
  credit_auto_reload_saved: {
    enabled: boolean;
    thresholdDollars: number;
    amountDollars: number;
  };
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

export function track<Name extends keyof AnalyticsEvents>(
  name: Name,
  ...props: AnalyticsEvents[Name] extends void
    ? []
    : [properties: AnalyticsEvents[Name]]
): void {
  posthog.capture(name, (props as [Record<string, unknown>?])[0]);
}
