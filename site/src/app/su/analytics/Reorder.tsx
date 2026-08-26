"use client";

import { useMemo } from "react";

import { useDragSort } from "@/components/Sortable";
import { useLocalPref } from "@/cut/lib/uiState";

export { SortCard as DragBlock } from "@/components/Sortable";

/**
 * Drag-to-reorder for a grid of dashboard blocks. localStorage keeps a list of
 * block ids; ids the page no longer renders drop out of it and blocks the page
 * gained land in their default position, so the saved order survives the
 * dashboard growing new cards.
 */
export function useReorder<T extends string>(key: string, ids: readonly T[]) {
  const [saved, setSaved] = useLocalPref<string[]>(
    key,
    [],
    (v) => Array.isArray(v) && v.every((x) => typeof x === "string"),
  );

  const stored = useMemo(() => {
    const kept = saved.filter((id): id is T => (ids as readonly string[]).includes(id));
    return [...kept, ...ids.filter((id) => !kept.includes(id))];
  }, [saved, ids]);

  const sort = useDragSort(stored, setSaved);

  return {
    blockProps: sort.itemProps,
    containerProps: sort.containerProps,
    customized: saved.length > 0,
    order: sort.order,
    reset: () => setSaved([]),
  };
}
