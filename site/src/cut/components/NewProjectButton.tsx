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
import { useNewProjectTarget } from "@/cut/lib/newProject";
import { RESIDENCY_LABEL, type Residency } from "@/cut/lib/residency";
import { cn } from "@/lib/utils";

const RESIDENCY_ICON: Record<Residency, typeof Cloud> = { local: Laptop, cloud: Cloud };

/**
 * Make a project, and say where it will land.
 *
 * The chevron is the residency choice, and it appears only when there is one
 * to make. Without the Donkey app running this Mac has no shelf, so every
 * project is a cloud project and this is a plain button. A folder pins its own
 * residency, since a project files only into a folder beside it.
 */
export function NewProjectButton({
  pinned = null,
  onCreate,
  className,
}: {
  pinned?: Residency | null;
  onCreate: (r: Residency) => void;
  className?: string;
}) {
  const { target, choices, pick } = useNewProjectTarget();
  const r = pinned ?? target;
  const Icon = RESIDENCY_ICON[r];

  if (pinned || choices.length < 2) {
    return (
      <Button className={className} onClick={() => onCreate(r)}>
        <Plus data-icon="inline-start" /> New project
      </Button>
    );
  }

  return (
    <div className={cn("flex", className)}>
      {/* The two halves read as one control: no seam between them. The base
          button's transparent border sits over the page with bg-clip-padding,
          so the facing borders have to go or they show as a line. */}
      <Button
        className="min-w-0 flex-1 rounded-r-none border-r-0"
        onClick={() => onCreate(r)}
      >
        <Plus data-icon="inline-start" /> New project
      </Button>
      <DropdownMenu>
        <DropdownMenuTrigger
          render={
            <Button
              aria-label={`New projects go to ${RESIDENCY_LABEL[r]}`}
              className="gap-1 rounded-l-none border-l-0 pr-2 pl-1.5"
            />
          }
        >
          <Icon className="size-3.5" />
          <ChevronDown className="size-3" />
        </DropdownMenuTrigger>
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
