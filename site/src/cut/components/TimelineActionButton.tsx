"use client";

import type { ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";

type Props = {
  label: string;
  tooltip: string;
  onClick: () => void;
  disabled?: boolean;
  /** A switch's state: set, the button reads as pressed. */
  pressed?: boolean;
  children: ReactNode;
};

export function TimelineActionButton({ label, tooltip, onClick, disabled, pressed, children }: Props) {
  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={label}
              aria-pressed={pressed}
              disabled={disabled}
              onClick={onClick}
              className={cn(pressed && "bg-[#0a84ff]/12 text-[#0a84ff] hover:bg-[#0a84ff]/20 hover:text-[#0a84ff] dark:hover:bg-[#0a84ff]/20")}
            />
          }
        >
          {children}
        </TooltipTrigger>
        <TooltipContent>{tooltip}</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
