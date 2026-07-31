"use client";

import { Switch } from "@/components/ui/switch";
import {
  useEmailPreferences,
  useSetEmailPreferences,
} from "@/queries/emailPreferences";

// The account's email choice: product news on or off. Transactional email
// (billing, security) is unaffected. This is also the way back in after an
// unsubscribe from an email footer.
export function EmailSection() {
  const { data: prefs } = useEmailPreferences();
  const set = useSetEmailPreferences();

  if (!prefs) return null;

  return (
    <div className="rounded-xl border bg-card p-5">
      <div className="text-sm font-medium">Email preferences</div>
      <div className="mt-4 border-t pt-4">
        <div className="flex items-start justify-between gap-6">
          <span className="min-w-0">
            <span className="block text-sm font-medium">Product emails</span>
            <span className="mt-0.5 block text-sm text-muted-foreground">
              News and announcements about Donkey Cut.
            </span>
          </span>
          <Switch
            aria-label="Product emails"
            checked={prefs.marketingEmails}
            onCheckedChange={(v) => set.mutate({ marketingEmails: v === true })}
          />
        </div>
        {set.isError && (
          <p className="mt-3 text-sm text-red-600">
            Couldn&apos;t save that change — try again.
          </p>
        )}
      </div>
    </div>
  );
}
