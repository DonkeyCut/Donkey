"use client";

import { useCallback } from "react";
import { useListedResidencies, useLocalCompute } from "@/cut/lib/backend/hooks";
import { useProjectsSection } from "@/cut/lib/queries";
import type { Residency } from "@/cut/lib/residency";

/**
 * The project listing of every shelf this browser lists, as Home and Assets
 * both read it: one cached query per shelf, and whether each takes writes.
 * The cloud and this browser always do; the Mac's does while its engine
 * answers, and lists what it last listed while it doesn't.
 */
export function useProjectShelves() {
  const residencies = useListedResidencies();
  const engineUp = useLocalCompute();

  // Hooks can't run in a loop, so every shelf is wired and an unlisted one
  // stays disabled.
  const local = useProjectsSection("local", { list: residencies.includes("local"), live: engineUp });
  const cloud = useProjectsSection("cloud", { list: residencies.includes("cloud"), live: true });
  const browser = useProjectsSection("browser", {
    list: residencies.includes("browser"),
    live: residencies.includes("browser"),
  });
  const live = useCallback((r: Residency) => r !== "local" || engineUp, [engineUp]);

  return { residencies, engineUp, live, sections: { local, cloud, browser } as Record<Residency, typeof local> };
}
