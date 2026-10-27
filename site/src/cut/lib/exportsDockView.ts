/** What the person last chose for the dock; null until they toggle it. */
export type DockChoice = "open" | "closed" | null;

const IN_FLIGHT = new Set(["running", "rendering", "queued", "preparing"]);

/**
 * Whether the exports dock shows its rows. It sits over the timeline, so
 * it opens while something renders or waits and rests on its header once
 * everything has settled. A toggle wins until the next export starts.
 */
export function exportsDockOpen(statuses: readonly string[], choice: DockChoice): boolean {
  if (choice !== null) {
    return choice === "open";
  }
  return inFlightCount(statuses) > 0;
}

/** How many exports are rendering or waiting their turn. */
export function inFlightCount(statuses: readonly string[]): number {
  return statuses.filter((s) => IN_FLIGHT.has(s)).length;
}
