"use client";

import { Switch } from "@/components/ui/switch";
import { useAccountFlags, useSetAccountFlag } from "@/queries/featureFlags";

// Editor preferences that belong to the account, so they follow the user to
// every browser: what the top bar shows, and whatever joins it later.
export function EditorSection() {
  const set = useSetAccountFlag();
  const prefs = useAccountFlags().data?.filter((f) => f.group === "editor");

  if (!prefs?.length) return null;

  return (
    <div className="rounded-xl border bg-card p-5">
      <div className="text-sm font-medium">Editor</div>
      <div className="mt-4 border-t pt-4">
        {prefs.map((pref, i) => (
          <div key={pref.id} className={i > 0 ? "mt-4 border-t pt-4" : undefined}>
            <div className="flex items-start justify-between gap-6">
              <span className="min-w-0">
                <span className="block text-sm font-medium">{pref.title}</span>
                <span className="mt-0.5 block text-sm text-muted-foreground">
                  {pref.description}
                </span>
              </span>
              <Switch
                aria-label={pref.title}
                checked={pref.enabled}
                onCheckedChange={(v) => set.mutate({ flag: pref.id, enabled: v === true })}
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
