"use client";

import { useTranslations } from "next-intl";

import { useFlagCopy } from "@/app/[locale]/cut/app/(home)/settings/profile/useFlagCopy";
import { Switch } from "@/components/ui/switch";
import { useAccountFlags, useSetAccountFlag } from "@/queries/featureFlags";

// Self-serve account feature flags, on the profile page rather than a page of
// their own — there are rarely more than a couple, and they belong to the
// account like everything else here. With no flags shipping there is nothing to
// say, so the section isn't there at all.
export function FeatureFlagsSection() {
  const t = useTranslations("settings");
  const flagCopy = useFlagCopy();
  const set = useSetAccountFlag();
  const flags = useAccountFlags().data?.filter((f) => f.group === "early");

  if (!flags?.length) return null;

  return (
    <div className="rounded-xl border bg-card p-5">
      <div className="text-sm font-medium">{t("flagsSection.title")}</div>
      <p className="mt-1 text-sm text-muted-foreground">{t("flagsSection.hint")}</p>

      <div className="mt-4 border-t pt-4">
        {flags.map((flag, i) => (
          <div key={flag.id} className={i > 0 ? "mt-4 border-t pt-4" : undefined}>
            <div className="flex items-start justify-between gap-6">
              <span className="min-w-0">
                <span className="block text-sm font-medium">{flagCopy(flag.id).title}</span>
                <span className="mt-0.5 block text-sm text-muted-foreground">
                  {flagCopy(flag.id).description}
                </span>
              </span>
              <Switch
                aria-label={flagCopy(flag.id).title}
                checked={flag.enabled}
                onCheckedChange={(v) =>
                  set.mutate({ flag: flag.id, enabled: v === true })
                }
              />
            </div>
          </div>
        ))}
        {set.isError && (
          <p className="mt-3 text-sm text-red-600">{t("saveFailed")}</p>
        )}
      </div>
    </div>
  );
}
