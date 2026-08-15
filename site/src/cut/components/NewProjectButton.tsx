"use client";

import { ChevronDown, Cloud, Laptop, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { useNewProjectTarget } from "@/cut/lib/newProject";
import { RESIDENCY_LABEL, type Residency } from "@/cut/lib/residency";
import { cn } from "@/lib/utils";

const RESIDENCY_ICON: Record<Residency, typeof Cloud> = {
  local: Laptop,
  cloud: Cloud,
  browser: Laptop,
};

// The picker is one switch for the whole app, and its tooltip is where that
// scope is stated: everything that lands on the shelf, then the shelf itself in
// bold. The break is written into the copy rather than left to a width, so the
// sentence reads the same in both shelves. The menu needs no more than the two
// names.
const RESIDENCY_LEAD = "All projects and media created going";
const RESIDENCY_SCOPE: Record<Residency, { tail: string; place: string }> = {
  local: { tail: "forward will be stored on", place: "this device" },
  cloud: { tail: "forward will be stored on the", place: "Cloud" },
  browser: { tail: "forward will be stored on", place: "this device" },
};

/**
 * Make a project, and — where the app keeps the switch — say where things land.
 *
 * The chevron is that switch, and it appears once, in the sidebar: it sets the
 * shelf for everything this browser creates, so every other New project button
 * follows it rather than asking again. It appears only when there is a choice
 * to make. Without the Donkey app running this Mac has no shelf, so every
 * project is a cloud project. A folder pins its own residency, since a project
 * files only into a folder beside it.
 */
export function NewProjectButton({
  pinned = null,
  picker = false,
  onCreate,
  className,
}: {
  pinned?: Residency | null;
  picker?: boolean;
  onCreate: (r: Residency) => void;
  className?: string;
}) {
  const { target, choices, pick } = useNewProjectTarget();
  const r = pinned ?? target;
  const Icon = RESIDENCY_ICON[r];

  if (!picker || pinned || choices.length < 2) {
    return (
      <Button className={className} onClick={() => onCreate(r)}>
        <Plus data-icon="inline-start" /> New project
      </Button>
    );
  }

  return (
    <div className={cn("flex items-center gap-1.5", className)}>
      {/* Two controls, not two halves of one: making a project and choosing the
          shelf are separate acts, so they stand apart rather than sharing an
          edge. */}
      <Button className="min-w-0 flex-1" onClick={() => onCreate(r)}>
        <Plus data-icon="inline-start" /> New project
      </Button>
      <DropdownMenu>
        <TooltipProvider>
          <Tooltip>
            <TooltipTrigger
              render={
                <DropdownMenuTrigger
                  render={
                    <Button
                      aria-label={`Where new projects and media are saved: ${RESIDENCY_LABEL[r]}`}
                      className="shrink-0 gap-1 px-2"
                    />
                  }
                >
                  <Icon className="size-3.5" />
                  <ChevronDown className="size-3" />
                </DropdownMenuTrigger>
              }
            />
            <TooltipContent className="flex-col items-start gap-0 py-2 text-left">
              <span>{RESIDENCY_LEAD}</span>
              <span>
                {RESIDENCY_SCOPE[r].tail}{" "}
                <span className="font-semibold">{RESIDENCY_SCOPE[r].place}</span>
              </span>
            </TooltipContent>
          </Tooltip>
        </TooltipProvider>
        <DropdownMenuContent align="end">
          <DropdownMenuRadioGroup value={r} onValueChange={(v) => pick(v as Residency)}>
            {choices.map((c) => {
              const ChoiceIcon = RESIDENCY_ICON[c];
              return (
                <DropdownMenuRadioItem key={c} value={c}>
                  <ChoiceIcon /> {RESIDENCY_LABEL[c]}
                </DropdownMenuRadioItem>
              );
            })}
          </DropdownMenuRadioGroup>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}
