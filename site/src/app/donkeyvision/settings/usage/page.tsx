"use client";

import { UsageCard } from "@/app/donkeyvision/settings/_components/UsageCard";
import { UsageHistoryCard } from "@/components/UsageHistoryCard";

export default function UsagePage() {
  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-2xl font-semibold">Usage</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Your recent Donkey app and Vision API calls.
        </p>
      </div>
      <UsageCard />
      <UsageHistoryCard />
    </div>
  );
}
