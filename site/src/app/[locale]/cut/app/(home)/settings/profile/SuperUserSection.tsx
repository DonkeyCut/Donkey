"use client";

import { Switch } from "@/components/ui/switch";
import { useAccountFlags, useSetAccountFlag } from "@/queries/featureFlags";

// Switches only a super user has. The flags route lists the group for that
// role alone, so for everyone else the section is not there.
export function SuperUserSection() {
  const set = useSetAccountFlag();
  const flags = useAccountFlags().data?.filter((f) => f.group === "su");

  if (!flags?.length) return null;

  return (
    <div className="rounded-xl border bg-card p-5">
      <div className="text-sm font-medium">Super user</div>
      <div className="mt-4 border-t pt-4">
        {flags.map((flag, i) => (
          <div key={flag.id} className={i > 0 ? "mt-4 border-t pt-4" : undefined}>
            <div className="flex items-start justify-between gap-6">
              <span className="min-w-0">
                <span className="block text-sm font-medium">{flag.title}</span>
                <span className="mt-0.5 block text-sm text-muted-foreground">
                  {flag.description}
                </span>
              </span>
              <Switch
                aria-label={flag.title}
                checked={flag.enabled}
                onCheckedChange={(v) => set.mutate({ flag: flag.id, enabled: v === true })}
              />
            </div>
          </div>
        ))}
        {set.isError && (
          <p className="mt-3 text-sm text-red-600">
            Couldn&apos;t save that change — try again.
          </p>
        )}
      </div>
    </div>
  );
}
