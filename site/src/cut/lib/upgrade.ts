// The upgrade wall's signal: what an account just ran into, or "plans" when
// it asked to see them. The dialog listens; anything that hits a paid limit
// raises it.
export type UpgradeReason = "projects" | "credits" | "plans";

// The button or limit that raised the wall, for analytics: where in the app
// people meet the plans. The storage entries come from the storage wall.
export type UpgradeEntry =
  | "credits_pill"
  | "storage_meter"
  | "settings"
  | "generate_button"
  | "credits_link"
  | "credits_refused"
  | "project_limit"
  | "storage_pill"
  | "storage_refused"
  | "storage_import"
  | "render_refused"
  | "onboarding_tour";

export type UpgradeRequest = { reason: UpgradeReason; entry: UpgradeEntry };

const listeners = new Set<(request: UpgradeRequest) => void>();

/** True when a dialog is mounted to show the wall. A surface without one
 * (the ChatGPT card) says the limit in its own words. */
export function openUpgrade(reason: UpgradeReason, entry: UpgradeEntry): boolean {
  for (const listener of listeners) {
    listener({ reason, entry });
  }
  return listeners.size > 0;
}

export function onUpgrade(handler: (request: UpgradeRequest) => void): () => void {
  listeners.add(handler);
  return () => {
    listeners.delete(handler);
  };
}
