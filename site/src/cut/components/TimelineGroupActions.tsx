"use client";

import { Group, Ungroup } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { DropdownMenuItem } from "@/components/ui/dropdown-menu";
import { useEditor } from "@/cut/lib/store";
import { createSelectedGroupSelector } from "@/cut/lib/timelineGroups";

export function TimelineGroupActions({ labels = true, menu = false }: { labels?: boolean; menu?: boolean }) {
  const count = useEditor((s) => s.multiSelection.length);
  const [selectGrouped] = useState(createSelectedGroupSelector);
  const grouped = useEditor(selectGrouped);
  const readOnly = useEditor((s) => s.readOnly);
  const group = () => useEditor.getState().groupSelection();
  const ungroup = () => useEditor.getState().ungroupSelection();
  if (menu) return <>
    <DropdownMenuItem disabled={readOnly || count < 2} onClick={group}><Group /> Group</DropdownMenuItem>
    <DropdownMenuItem disabled={readOnly || !grouped} onClick={ungroup}><Ungroup /> Ungroup</DropdownMenuItem>
  </>;
  return <>
    <Button variant="ghost" size={labels ? "sm" : "icon-sm"} title="Group (⌘/Ctrl+G)" disabled={readOnly || count < 2} onClick={group}>
      <Group />{labels && <span>Group</span>}
    </Button>
    <Button variant="ghost" size={labels ? "sm" : "icon-sm"} title="Ungroup (⇧⌘/Ctrl+G)" disabled={readOnly || !grouped} onClick={ungroup}>
      <Ungroup />{labels && <span>Ungroup</span>}
    </Button>
  </>;
}
