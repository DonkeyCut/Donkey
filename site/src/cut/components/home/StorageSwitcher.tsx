"use client";

import { ChevronDown, Cloud, Laptop } from "lucide-react";
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
import { useNewProjectTarget } from "@/cut/lib/newProject";
import type { Residency } from "@/cut/lib/residency";
import { useLabels } from "@/i18n/labels";
import { cn } from "@/lib/utils";

const RESIDENCY_ICON: Record<Residency, typeof Cloud> = {
  local: Laptop,
  cloud: Cloud,
  browser: Laptop,
};

/**
 * Where new projects land: Cloud or Local. One choice for every new project —
 * from the prompt, Blank project, or a template — remembered on this browser.
 * With one place in reach there is nothing to choose, so it stays away.
 */
export function StorageSwitcher({ className }: { className?: string }) {
  const t = useTranslations("home.start");
  const residencyLabel = useLabels("residency");
  const { target, choices, pick } = useNewProjectTarget();
  if (choices.length < 2) {
    return null;
  }

  const Icon = RESIDENCY_ICON[target];
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button
            variant="default"
            aria-label={t("storageButton", { place: residencyLabel(target) })}
            className={cn("gap-1.5 px-3", className)}
          />
        }
      >
        <Icon className="size-4" />
        {residencyLabel(target)}
        <ChevronDown className="size-3 opacity-70" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-52">
        <DropdownMenuGroup>
          <DropdownMenuLabel>{t("storageLabel")}</DropdownMenuLabel>
          <DropdownMenuRadioGroup value={target} onValueChange={(v) => pick(v as Residency)}>
            {choices.map((c) => {
              const ChoiceIcon = RESIDENCY_ICON[c];
              return (
                <DropdownMenuRadioItem key={c} value={c}>
                  <ChoiceIcon /> {residencyLabel(c)}
                </DropdownMenuRadioItem>
              );
            })}
          </DropdownMenuRadioGroup>
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
