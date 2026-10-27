"use client";

import { Laptop, Smartphone } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";

import { Button } from "@/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { useLocalCompute } from "@/cut/lib/backend/hooks";
import type { Locale } from "@/i18n/locales";
import { useAccount } from "@/queries/credits";
import {
  useCancelPhonePairing,
  usePhoneLink,
  useStartPhonePairing,
  useUnpairPhone,
} from "@/queries/phoneLink";

// Pairing a phone with this Mac, so a shoot in the field reaches the editor.
//
// The clips ride peer-to-peer Wi-Fi from the phone to the Mac app, which hands
// them to the engine; the editor takes them from there into whichever project is
// open. Nothing about it needs a network, which is the whole point — the phone
// and the Mac find each other on the radio and talk directly.
//
// Super user only, and only on a Mac running the app: there is no hosted twin of
// a Bonjour listener, so with no engine here there is nothing to pair with.
export function PhoneLinkSection() {
  const t = useTranslations("settings.phoneLink");
  const locale = useLocale();
  const superUser = useAccount().data?.superUser === true;
  const hasEngine = useLocalCompute();
  const link = usePhoneLink(superUser && hasEngine);
  const start = useStartPhonePairing();
  const cancel = useCancelPhonePairing();
  const unpair = useUnpairPhone();

  if (!superUser || !hasEngine) return null;

  const devices = link.data?.devices ?? [];
  const pairing = link.data?.pairing ?? null;
  const refused = link.data?.closed === "refused";

  return (
    <div className="rounded-xl border bg-card p-5">
      <div className="flex items-center gap-2">
        <Laptop className="size-4 text-muted-foreground" />
        <div className="text-sm font-medium">{t("title")}</div>
      </div>
      <p className="mt-1 text-sm text-muted-foreground">{t("body")}</p>

      <div className="mt-4 border-t pt-4">
        {pairing ? (
          <div>
            <p className="text-sm">{t("instructions")}</p>
            <div className="mt-3 font-mono text-3xl tracking-[0.2em] tabular-nums">
              {pairing.code}
            </div>
            <div className="mt-3 flex items-center gap-2">
              <Button variant="outline" size="sm" onClick={() => cancel.mutate()}>
                {t("cancel")}
              </Button>
              <span className="text-sm text-muted-foreground">{t("codeLife")}</span>
            </div>
          </div>
        ) : (
          <div className="flex items-center gap-3">
            <Button size="sm" onClick={() => start.mutate()} disabled={start.isPending}>
              {t("pair")}
            </Button>
            {refused && <span className="text-sm text-red-600">{t("refused")}</span>}
          </div>
        )}

        {devices.length > 0 && (
          <ul className="mt-4 space-y-3 border-t pt-4">
            {devices.map((device) => (
              <li key={device.id} className="flex items-center justify-between gap-6">
                <span className="flex min-w-0 items-center gap-2">
                  <Smartphone className="size-4 shrink-0 text-muted-foreground" />
                  <span className="min-w-0">
                    <span className="block truncate text-sm font-medium">{device.name}</span>
                    <span className="mt-0.5 block text-sm text-muted-foreground">
                      {t("lastSeen", { when: relative(device.lastSeenAt, locale, t("justNow")) })}
                    </span>
                  </span>
                </span>
                <TooltipProvider>
                  <Tooltip>
                    <TooltipTrigger
                      render={
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => unpair.mutate(device.id)}
                          disabled={unpair.isPending}
                        >
                          {t("unpair")}
                        </Button>
                      }
                    />
                    <TooltipContent>{t("unpairHint")}</TooltipContent>
                  </Tooltip>
                </TooltipProvider>
              </li>
            ))}
          </ul>
        )}

        {(start.isError || unpair.isError) && (
          <p className="mt-3 text-sm text-red-600">{t("unreachable")}</p>
        )}
      </div>
    </div>
  );
}

/** "3 minutes ago", down to `justNow`. */
function relative(stamp: number, locale: Locale, justNow: string): string {
  const seconds = Math.round((Date.now() - stamp) / 1000);
  if (seconds < 60) return justNow;
  const units: [Intl.RelativeTimeFormatUnit, number][] = [
    ["minute", 60],
    ["hour", 3600],
    ["day", 86400],
  ];
  const format = new Intl.RelativeTimeFormat(locale, { numeric: "auto" });
  let unit: Intl.RelativeTimeFormatUnit = "minute";
  let size = 60;
  for (const [candidate, candidateSize] of units) {
    if (seconds >= candidateSize) {
      unit = candidate;
      size = candidateSize;
    }
  }
  return format.format(-Math.round(seconds / size), unit);
}
