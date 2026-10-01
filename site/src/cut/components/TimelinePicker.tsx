"use client";

import { ChevronDown } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useEditor } from "@/cut/lib/store";
import { switchTimeline, useTimelinePicker } from "@/cut/lib/timelineSwitch";
import { isTimelineId, TIMELINE_IDS, TIMELINE_LABELS } from "@/cut/lib/types";

/** The timeline picker at the head of the toolbar: the open timeline's name,
 * and the project's others under it. Held while work is still landing on the
 * open one. */
export function TimelinePicker() {
  const timeline = useEditor((s) => s.timeline);
  const readOnly = useEditor((s) => s.readOnly);
  const { supported, blocked } = useTimelinePicker();
  if (readOnly || !supported) return null;
  return (
    <>
    <DropdownMenu>
      <DropdownMenuTrigger
        disabled={blocked}
        render={<Button variant="ghost" size="sm" className="shrink-0 gap-1 px-2" aria-label="Timeline" />}
      >
        {TIMELINE_LABELS[timeline]}
        <ChevronDown className="size-3.5 text-muted-foreground" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-40">
        <DropdownMenuGroup>
          <DropdownMenuLabel>Timelines</DropdownMenuLabel>
          <DropdownMenuRadioGroup
            value={timeline}
            onValueChange={(id) => {
              if (isTimelineId(id)) void switchTimeline(id);
            }}
          >
            {TIMELINE_IDS.map((id) => (
              <DropdownMenuRadioItem key={id} value={id}>
                {TIMELINE_LABELS[id]}
              </DropdownMenuRadioItem>
            ))}
          </DropdownMenuRadioGroup>
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
    <div role="separator" aria-orientation="vertical" className="mx-1 h-4 w-px shrink-0 bg-border" />
    </>
  );
}
