"use client";

import { ChevronDown, Grid3x3 } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { GUIDE_PRESETS, guideFits } from "@/cut/lib/guides";
import { useEditor } from "@/cut/lib/store";
import { cn } from "@/lib/utils";

/** The preview guides control beside the timeline zoom: the icon shows and
 * hides the guides (⌘;), the chevron beside it picks which presets draw. A
 * first press with nothing picked turns on the safe margins. The icon lights
 * while any guide is showing. */
export function GuidesMenu() {
  const aspect = useEditor((s) => s.aspect);
  const guides = useEditor((s) => s.guides);
  const guidesHidden = useEditor((s) => s.guidesHidden);
  const showing = guides.length > 0 && !guidesHidden;
  const toggle = () => {
    const s = useEditor.getState();
    if (s.guides.length === 0) s.toggleGuide("margins");
    else s.setGuidesHidden(!s.guidesHidden);
  };
  return (
    <div
      className={cn(
        "mr-2 flex items-center overflow-hidden rounded-md border border-border",
        showing && "bg-accent text-foreground"
      )}
    >
      <Button
        variant="ghost"
        size="icon-xs"
        aria-label={showing ? "Hide guides" : "Show guides"}
        title={showing ? "Hide guides (⌘;)" : "Show guides (⌘;)"}
        aria-pressed={showing}
        className="rounded-r-none"
        onClick={toggle}
      >
        <Grid3x3 className="size-5" strokeWidth={1.5} />
      </Button>
      <DropdownMenu>
        <DropdownMenuTrigger
          render={
            <Button
              variant="ghost"
              size="icon-xs"
              aria-label="Guide presets"
              title="Guide presets"
              className="w-4 rounded-l-none"
            />
          }
        >
          <ChevronDown className="size-3" />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-52">
          <DropdownMenuGroup>
            <DropdownMenuLabel>Guides</DropdownMenuLabel>
            {GUIDE_PRESETS.map((g) => {
              const fits = guideFits(g.id, aspect);
              return (
                <DropdownMenuCheckboxItem
                  key={g.id}
                  checked={guides.includes(g.id)}
                  disabled={!fits}
                  closeOnClick={false}
                  onCheckedChange={() => useEditor.getState().toggleGuide(g.id)}
                >
                  <span className="flex-1">
                    {g.name}
                    {g.sublabel && (
                      <span className="block text-[10.5px] text-muted-foreground">
                        {fits ? g.sublabel : "Portrait frames"}
                      </span>
                    )}
                  </span>
                </DropdownMenuCheckboxItem>
              );
            })}
          </DropdownMenuGroup>
          <DropdownMenuSeparator />
          <DropdownMenuItem closeOnClick={false} onClick={() => useEditor.getState().addGuideLine("v")}>
            Add vertical line
          </DropdownMenuItem>
          <DropdownMenuItem closeOnClick={false} onClick={() => useEditor.getState().addGuideLine("h")}>
            Add horizontal line
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}
