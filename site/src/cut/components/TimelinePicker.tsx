"use client";

import { ChevronDown } from "lucide-react";
import { useTranslations } from "next-intl";
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
import { timelineEnd } from "@/cut/lib/timelineEnd";
import { switchTimeline, useTimelinePicker } from "@/cut/lib/timelineSwitch";
import { isTimelineId, TIMELINE_IDS, type TimelineBody } from "@/cut/lib/types";
import { useLabels } from "@/i18n/labels";

/** The timeline picker at the head of the toolbar: the open timeline's name,
 * and the project's others under it. Held while work is still landing on the
 * open one. */
export function TimelinePicker() {
  const t = useTranslations("timeline.picker");
  const timelineLabel = useLabels("timeline");
  const timeline = useEditor((s) => s.timeline);
  const readOnly = useEditor((s) => s.readOnly);
  const { supported, blocked } = useTimelinePicker();
  if (readOnly || !supported) return null;
  return (
    <>
    <DropdownMenu>
      <DropdownMenuTrigger
        disabled={blocked}
        render={<Button variant="ghost" size="sm" className="shrink-0 gap-1 px-2" aria-label={t("label")} />}
      >
        {timelineLabel(timeline)}
        <ChevronDown className="size-3.5 text-muted-foreground" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-40">
        <DropdownMenuGroup>
          <DropdownMenuLabel>{t("heading")}</DropdownMenuLabel>
          <DropdownMenuRadioGroup
            value={timeline}
            onValueChange={(id) => {
              if (isTimelineId(id)) void switchTimeline(id);
            }}
          >
            {TIMELINE_IDS.map((id) => (
              <DropdownMenuRadioItem key={id} value={id}>
                {timelineLabel(id)}
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

// A parked timeline holds the edit by the same rule the open one is empty by:
// it ends past zero. Parked bodies change only on a switch, so each one's end
// is computed once.
const parkedEnds = new WeakMap<Partial<TimelineBody>, number>();
function holdsItems(b: Partial<TimelineBody> | undefined): boolean {
  if (!b) {
    return false;
  }
  let end = parkedEnds.get(b);
  if (end === undefined) {
    end = timelineEnd(b);
    parkedEnds.set(b, end);
  }
  return end > 0;
}

/** The note an empty timeline shows when another of the project's timelines
 * holds the edit, so opening an empty one never reads as the edit gone. */
export function EmptyTimelineNote() {
  const t = useTranslations("timeline.picker");
  const timelineLabel = useLabels("timeline");
  const timeline = useEditor((s) => s.timeline);
  const readOnly = useEditor((s) => s.readOnly);
  const other = useEditor((s) => TIMELINE_IDS.find((id) => id !== s.timeline && holdsItems(s.timelines[id])));
  const { supported, blocked } = useTimelinePicker();
  if (readOnly || !supported || !other) {
    return null;
  }

  // Centered over the lanes; only the button takes the pointer, so drops onto
  // the empty timeline still land.
  return (
    <div className="pointer-events-none absolute inset-0 z-30 grid place-items-center">
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <span>
          {t("emptyNote", { current: timelineLabel(timeline), other: timelineLabel(other) })}
        </span>
        <Button
          variant="outline"
          size="sm"
          className="pointer-events-auto"
          disabled={blocked}
          onClick={() => void switchTimeline(other)}
        >
          {t("open", { name: timelineLabel(other) })}
        </Button>
      </div>
    </div>
  );
}
