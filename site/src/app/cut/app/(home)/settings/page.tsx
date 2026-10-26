"use client";

import { CreditsCard } from "@/app/cut/app/(home)/settings/_components/CreditsCard";
import { ProCard } from "@/app/cut/app/(home)/settings/_components/ProCard";
import { SettingsGuard } from "@/cut/components/SettingsGuard";

// Cut's billing page: the Pro subscription that carries the monthly AI
// credits, plus the credit balance and top-ups.
export default function CutBillingPage() {
  return (
    <SettingsGuard>
      <div className="max-w-2xl space-y-6 pb-9">
        <ProCard />
        <CreditsCard />
      </div>
    </SettingsGuard>
  );
}
