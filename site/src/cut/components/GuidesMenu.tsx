"use client";

import { ChevronDown, Grid3x3 } from "lucide-react";
import { useFormatter, useTranslations } from "next-intl";
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
import { GUIDE_PRESETS, guideFits, MARGIN_INSET, type GuideId } from "@/cut/lib/guides";
import { useEditor } from "@/cut/lib/store";
import { cn } from "@/lib/utils";

/** The preview guides control beside the timeline zoom: the icon shows and
 * hides the guides (⌘;), the chevron beside it picks which presets draw. A
 * first press with nothing picked turns on the safe margins. The icon lights
 * while any guide is showing. */
export function GuidesMenu() {
  const t = useTranslations("timeline.guides");
  const format = useFormatter();
  const aspect = useEditor((s) => s.aspect);
  const guides = useEditor((s) => s.guides);
  const guidesHidden = useEditor((s) => s.guidesHidden);
  const showing = guides.length > 0 && !guidesHidden;
  const toggle = () => useEditor.getState().toggleGuidesShown();

  // A preset's second line, for the presets that carry one: the margins name
  // their inset, e.g. "5% inset".
  const sublabel = (id: GuideId) => {
    if (id === "margins") {
      return t("sublabels.margins", { inset: format.number(MARGIN_INSET, { style: "percent" }) });
    }
    if (id === "shortform" || id === "custom") {
      return t(`sublabels.${id}`);
    }
    return null;
  };
  return (
    <div className="mr-2 flex items-center overflow-hidden rounded-md border border-border">
      <Button
        variant="ghost"
        size="icon-xs"
        aria-label={showing ? t("hide") : t("show")}
        title={showing ? t("hideTitle", { key: "⌘;" }) : t("showTitle", { key: "⌘;" })}
        aria-pressed={showing}
        className="rounded-r-none"
        onClick={toggle}
      >
        <Grid3x3 className={cn("size-5", showing && "text-[#0a84ff]")} strokeWidth={1.5} />
      </Button>
      <DropdownMenu>
        <DropdownMenuTrigger
          render={
            <Button
              variant="ghost"
              size="icon-xs"
              aria-label={t("presetsLabel")}
              title={t("presetsLabel")}
              className="w-4 rounded-l-none"
            />
          }
        >
          <ChevronDown className="size-3" />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-52">
          <DropdownMenuGroup>
            <DropdownMenuLabel>{t("heading")}</DropdownMenuLabel>
            {GUIDE_PRESETS.map((g) => {
              const fits = guideFits(g.id, aspect);
              const sub = sublabel(g.id);
              return (
                <DropdownMenuCheckboxItem
                  key={g.id}
                  checked={guides.includes(g.id)}
                  disabled={!fits}
                  closeOnClick={false}
                  onCheckedChange={() => useEditor.getState().toggleGuide(g.id)}
                >
                  <span className="flex-1">
                    {t(`presets.${g.id}`)}
                    {sub && (
                      <span className="block text-[10.5px] text-muted-foreground">
                        {fits ? sub : t("portraitOnly")}
                      </span>
                    )}
                  </span>
                </DropdownMenuCheckboxItem>
              );
            })}
          </DropdownMenuGroup>
          <DropdownMenuSeparator />
          <DropdownMenuItem closeOnClick={false} onClick={() => useEditor.getState().addGuideLine("v")}>
            {t("addVertical")}
          </DropdownMenuItem>
          <DropdownMenuItem closeOnClick={false} onClick={() => useEditor.getState().addGuideLine("h")}>
            {t("addHorizontal")}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}
