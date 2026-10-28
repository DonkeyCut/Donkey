"use client";

import { useLocale, useTranslations } from "next-intl";

import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { formatCredits } from "@/lib/credits/format-credits";
import { useCreditBalance } from "@/queries/credits";

export function CreditsCard() {
  const t = useTranslations("settings.credits");
  const locale = useLocale();
  const balance = useCreditBalance();

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("title")}</CardTitle>
        <CardDescription>{t("description")}</CardDescription>
      </CardHeader>
      <CardContent>
        {balance.isLoading ? (
          <Skeleton className="h-9 w-32" />
        ) : (
          <div className="text-3xl font-semibold tabular-nums">
            {formatCredits(balance.data?.balance ?? "0", locale)}
          </div>
        )}
        <p className="mt-1 text-sm text-muted-foreground">{t("available")}</p>
      </CardContent>
    </Card>
  );
}
