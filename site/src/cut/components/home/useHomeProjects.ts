"use client";

import { useMemo } from "react";
import { useProjectShelves } from "@/cut/hooks/useProjectShelves";
import type { Residency } from "@/cut/lib/residency";
import type { ProjectSummary } from "@/cut/lib/types";

/** One project on Home, with the shelf it lives on. */
export type HomeProject = { project: ProjectSummary; residency: Residency };

/**
 * Every project on the shelves this browser lists, newest edit first, read
 * from the same cached listings Assets reads. Templates list under Templates.
 * A shelf whose engine isn't answering still lists what it last listed.
 */
export function useHomeProjects() {
  const { residencies, live, sections } = useProjectShelves();
  const { local, cloud, browser } = sections;

  const projects = useMemo(() => {
    const listed: [Residency, ProjectSummary[] | undefined][] = [
      ["local", local.data?.projects],
      ["cloud", cloud.data?.projects],
      ["browser", browser.data?.projects],
    ];
    return listed
      .filter(([r]) => residencies.includes(r))
      .flatMap(([residency, list]) =>
        (list ?? []).filter((p) => p.kind !== "template").map((project) => ({ project, residency }))
      )
      .sort((a, b) => (b.project.updatedAt ?? 0) - (a.project.updatedAt ?? 0));
  }, [local.data, cloud.data, browser.data, residencies]);

  // Still loading while a listed shelf with nothing cached is being read.
  const loading = residencies.some((r) => sections[r].isLoading);

  return { projects, loading, live, dual: residencies.length > 1 };
}
