import type { Metadata } from "next";
import type { ReactNode } from "react";
import { getTranslations } from "next-intl/server";

import { SettingsHeader } from "@/app/[locale]/cut/app/(home)/settings/SettingsHeader";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("settings.meta");
  return { description: t("description") };
}

// Billing and Usage render inside the Cut app shell (the home layout's
// sidebar); the account menu in the sidebar footer is how users get here.
// The whole pane is the scroll container, so the scrollbar spans it top to
// bottom; the title stays pinned by being sticky inside it. Pages still pick
// their behavior: billing overflows and scrolls the pane, usage fills the
// remaining height exactly (flex-1 + h-full chain) and scrolls only its table
// body. p-px gives the cards' outside ring a pixel of room so the scroll
// container can't clip their top border. Each page holds its own
// SettingsGuard, so the page segment renders and Next can validate it.
export default function CutSettingsLayout({ children }: { children: ReactNode }) {
  return (
    <div className="flex h-full flex-col overflow-y-auto">
      <SettingsHeader />
      <div className="min-h-0 flex-1">
        <div className="mx-auto h-full w-full max-w-6xl px-10">
          <div className="h-full p-px">{children}</div>
        </div>
      </div>
    </div>
  );
}
