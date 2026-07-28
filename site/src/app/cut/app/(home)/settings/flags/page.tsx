"use client";

import { useEffect, useState } from "react";

import { Switch } from "@/components/ui/switch";

type FlagRow = { id: string; title: string; description: string; enabled: boolean };

// Self-serve account feature flags. The account is the source of truth: the
// switch writes the row and the page holds the new state optimistically until
// the write answers.
export default function CutFeatureFlagsPage() {
  const [flags, setFlags] = useState<FlagRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    void fetch("/api/account/feature-flags")
      .then(async (res) => {
        if (!res.ok) throw new Error();
        const body = (await res.json()) as { flags: FlagRow[] };
        if (alive) setFlags(body.flags);
      })
      .catch(() => {
        if (alive) setError("Couldn't load your feature flags.");
      });
    return () => {
      alive = false;
    };
  }, []);

  const toggle = (id: string, enabled: boolean) => {
    setFlags((cur) => cur?.map((f) => (f.id === id ? { ...f, enabled } : f)) ?? cur);
    void fetch("/api/account/feature-flags", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ flag: id, enabled }),
    }).then((res) => {
      if (res.ok) return;
      // The account write failed; put the switch back.
      setFlags((cur) => cur?.map((f) => (f.id === id ? { ...f, enabled: !enabled } : f)) ?? cur);
      setError("Couldn't save that change — try again.");
    });
  };

  return (
    <div className="max-w-2xl space-y-6 pb-9">
      <div className="rounded-xl border bg-card p-5">
        {error && <p className="mb-3 text-sm text-red-600">{error}</p>}
        {!flags && !error && <p className="text-sm text-muted-foreground">Loading…</p>}
        {flags?.length === 0 && (
          <p className="text-sm text-muted-foreground">
            There are no early features to turn on right now.
          </p>
        )}
        {flags?.map((f, i) => (
          <div key={f.id} className={i > 0 ? "mt-4 border-t pt-4" : undefined}>
            <div className="flex items-start justify-between gap-6">
              <span className="min-w-0">
                <span className="block text-sm font-medium">{f.title}</span>
                <span className="mt-0.5 block text-sm text-muted-foreground">
                  {f.description}
                </span>
              </span>
              <Switch
                aria-label={f.title}
                checked={f.enabled}
                onCheckedChange={(v) => toggle(f.id, v === true)}
              />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
