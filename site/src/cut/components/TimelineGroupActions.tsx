"use client";

import { Group, Ungroup } from "lucide-react";
import { useState } from "react";
import { TimelineActionButton } from "@/cut/components/TimelineActionButton";
import { DropdownMenuItem } from "@/components/ui/dropdown-menu";
import { useEditor } from "@/cut/lib/store";
import { createSelectedGroupSelector } from "@/cut/lib/timelineGroups";

export function TimelineGroupActions({ menu = false }: { menu?: boolean }) {
  const count = useEditor((s) => s.multiSelection.length);
  const [selectGrouped] = useState(createSelectedGroupSelector);
  const grouped = useEditor(selectGrouped);
  const readOnly = useEditor((s) => s.readOnly);
  const group = () => useEditor.getState().groupSelection();
  const ungroup = () => useEditor.getState().ungroupSelection();
  if (readOnly) return null;
  if (menu) return <>
    {count >= 2 && <DropdownMenuItem onClick={group}><Group /> Group</DropdownMenuItem>}
    {grouped && <DropdownMenuItem onClick={ungroup}><Ungroup /> Ungroup</DropdownMenuItem>}
  </>;
  return <>
    {count >= 2 && (
      <TimelineActionButton label="Group" tooltip="Group (⌘/Ctrl+G)" onClick={group}><Group /></TimelineActionButton>
    )}
    {grouped && (
      <TimelineActionButton label="Ungroup" tooltip="Ungroup (⇧⌘/Ctrl+G)" onClick={ungroup}><Ungroup /></TimelineActionButton>
    )}
  </>;
}
