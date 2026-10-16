/** One shelf's listing as the projects home reads it. */
type ShelfListing = {
  // Null until the shelf has answered once (or a snapshot seeded it).
  projects: readonly unknown[] | null;
  folders: readonly unknown[];
  error: boolean;
  // Fetching its first answer, with nothing cached to show.
  loading: boolean;
};

type HomeView = "loading" | "failed" | "empty" | "content";

/**
 * What the projects home draws. Cards show as soon as any shelf has them. The
 * empty state waits until no shelf is still loading its first answer: a
 * browser shelf that answers empty first must not flash "Create a new
 * project" over cloud projects still on their way. A shelf nothing is reading
 * (the Mac's, with the app closed) holds nothing up.
 */
export function projectsHomeView(shelves: readonly ShelfListing[]): HomeView {
  if (shelves.some((s) => (s.projects?.length ?? 0) > 0 || s.folders.length > 0)) {
    return "content";
  }

  const anySettled = shelves.some((s) => s.projects !== null || s.error);
  if (!anySettled || shelves.some((s) => s.loading)) {
    return "loading";
  }
  return shelves.every((s) => s.error) ? "failed" : "empty";
}
