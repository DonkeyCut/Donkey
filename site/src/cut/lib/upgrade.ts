// The upgrade wall's signal: what an account just ran into, or "plans" when
// it asked to see them. The dialog listens; anything that hits a paid limit
// raises it.
export type UpgradeReason = "projects" | "credits" | "plans";

const listeners = new Set<(reason: UpgradeReason) => void>();

/** True when a dialog is mounted to show the wall. A surface without one
 * (the ChatGPT card) says the limit in its own words. */
export function openUpgrade(reason: UpgradeReason): boolean {
  for (const listener of listeners) {
    listener(reason);
  }
  return listeners.size > 0;
}

export function onUpgrade(handler: (reason: UpgradeReason) => void): () => void {
  listeners.add(handler);
  return () => {
    listeners.delete(handler);
  };
}
