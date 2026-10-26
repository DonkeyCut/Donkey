"use client";

import { UsageHistoryCard } from "@/components/UsageHistoryCard";
import { SettingsGuard } from "@/cut/components/SettingsGuard";

export default function CutUsagePage() {
  return (
    <SettingsGuard>
      <UsageHistoryCard />
    </SettingsGuard>
  );
}
