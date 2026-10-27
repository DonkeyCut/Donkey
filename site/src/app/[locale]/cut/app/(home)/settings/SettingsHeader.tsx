"use client";

import { usePathname } from "next/navigation";
import { useTranslations } from "next-intl";

import { useTabTitle } from "@/cut/hooks/useTabTitle";

// Ordered so the more specific path wins the suffix match. The title stays
// pinned while the cards scroll.
// Titles and descriptions are `settings.header` catalog keys.
const SECTIONS = [
  {
    suffix: "/settings/profile",
    title: "profileTitle",
  },
  {
    suffix: "/settings",
    title: "billingTitle",
    description: "billingDescription",
  },
] as const satisfies {
  suffix: string;
  title: string;
  description?: string;
}[];

export function SettingsHeader() {
  const t = useTranslations("settings.header");
  const pathname = usePathname();
  // Billing is the settings root, so it's also the fallback title.
  const section: (typeof SECTIONS)[number] =
    SECTIONS.find((s) => pathname.endsWith(s.suffix)) ?? SECTIONS[SECTIONS.length - 1];
  const title = t(section.title);
  const description = "description" in section ? t(section.description) : null;
  useTabTitle(title);
  return (
    <div className="sticky top-0 z-20 mx-auto w-full max-w-6xl shrink-0 bg-background px-10 pt-9 pb-5">
      <h1 className="text-lg font-semibold tracking-tight">{title}</h1>
      {description && (
        <p className="mt-1 text-sm text-muted-foreground">{description}</p>
      )}
    </div>
  );
}
