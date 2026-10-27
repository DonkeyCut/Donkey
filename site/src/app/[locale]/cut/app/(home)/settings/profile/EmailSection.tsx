"use client";

import { useTranslations } from "next-intl";

import { Switch } from "@/components/ui/switch";
import {
  useEmailPreferences,
  useSetEmailPreferences,
} from "@/queries/emailPreferences";

// The account's email choice: product news on or off. Transactional email
// (billing, security) is unaffected. This is also the way back in after an
// unsubscribe from an email footer.
export function EmailSection() {
  const t = useTranslations("settings");
  const { data: prefs } = useEmailPreferences();
  const set = useSetEmailPreferences();

  if (!prefs) return null;

  return (
    <div className="rounded-xl border bg-card p-5">
      <div className="text-sm font-medium">{t("email.title")}</div>
      <div className="mt-4 border-t pt-4">
        <div className="flex items-start justify-between gap-6">
          <span className="min-w-0">
            <span className="block text-sm font-medium">{t("email.product")}</span>
            <span className="mt-0.5 block text-sm text-muted-foreground">
              {t("email.productHint")}
            </span>
          </span>
          <Switch
            aria-label={t("email.product")}
            checked={prefs.marketingEmails}
            onCheckedChange={(v) => set.mutate({ marketingEmails: v === true })}
          />
        </div>
        {set.isError && (
          <p className="mt-3 text-sm text-red-600">{t("saveFailed")}</p>
        )}
      </div>
    </div>
  );
}
