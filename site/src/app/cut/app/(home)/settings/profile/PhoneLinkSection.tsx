"use client";

import { Laptop, Smartphone } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { useLocalCompute } from "@/cut/lib/backend/hooks";
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
        <div className="text-sm font-medium">Phone link</div>
      </div>
      <p className="mt-1 text-sm text-muted-foreground">
        Send video from the Donkey Cut iPhone app straight to this Mac over Wi-Fi Direct, with
        or without a network. Clips land in the project you have open.
      </p>

      <div className="mt-4 border-t pt-4">
        {pairing ? (
          <div>
            <p className="text-sm">
              On the phone, open the avatar menu → Mac Link, pick this Mac, and type:
            </p>
            <div className="mt-3 font-mono text-3xl tracking-[0.2em] tabular-nums">
              {pairing.code}
            </div>
            <div className="mt-3 flex items-center gap-2">
              <Button variant="outline" size="sm" onClick={() => cancel.mutate()}>
                Cancel
              </Button>
              <span className="text-sm text-muted-foreground">
                The code is good for five minutes.
              </span>
            </div>
          </div>
        ) : (
          <div className="flex items-center gap-3">
            <Button size="sm" onClick={() => start.mutate()} disabled={start.isPending}>
              Pair a phone
            </Button>
            {refused && (
              <span className="text-sm text-red-600">
                The last code was answered wrong three times and closed. Start a new one.
              </span>
            )}
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
                      Last seen {relative(device.lastSeenAt)}
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
                          Unpair
                        </Button>
                      }
                    />
                    <TooltipContent>This phone stops being able to send here</TooltipContent>
                  </Tooltip>
                </TooltipProvider>
              </li>
            ))}
          </ul>
        )}

        {(start.isError || unpair.isError) && (
          <p className="mt-3 text-sm text-red-600">
            Couldn&apos;t reach the app on this Mac — check that it&apos;s running.
          </p>
        )}
      </div>
    </div>
  );
}

/** "3 minutes ago", down to "just now". */
function relative(stamp: number): string {
  const seconds = Math.round((Date.now() - stamp) / 1000);
  if (seconds < 60) return "just now";
  const units: [Intl.RelativeTimeFormatUnit, number][] = [
    ["minute", 60],
    ["hour", 3600],
    ["day", 86400],
  ];
  const format = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });
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
