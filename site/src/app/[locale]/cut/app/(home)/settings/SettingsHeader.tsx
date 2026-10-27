"use client";

import { usePathname } from "next/navigation";
import { useTranslations } from "next-intl";

import { useTabTitle } from "@/cut/hooks/useTabTitle";
import { cn } from "@/lib/utils";

// Ordered so the more specific path wins the suffix match. Billing pins its
// title while the cards scroll; usage lets the title scroll away so the
// table's own pinned column header takes the top of the pane.
// Titles and descriptions are `settings.header` catalog keys.
const SECTIONS = [
  {
    suffix: "/settings/usage",
    title: "usageTitle",
    description: "usageDescription",
    pinned: false,
  },
  {
    suffix: "/settings/profile",
    title: "profileTitle",
    pinned: true,
  },
  {
    suffix: "/settings",
    title: "billingTitle",
    description: "billingDescription",
    pinned: true,
  },
] as const satisfies {
  suffix: string;
  title: string;
  description?: string;
  pinned: boolean;
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
    <div
      className={cn(
        "mx-auto w-full max-w-6xl shrink-0 px-10 pt-9 pb-5",
        section.pinned && "sticky top-0 z-20 bg-background",
      )}
    >
      <h1 className="text-lg font-semibold tracking-tight">{title}</h1>
      {description && (
        <p className="mt-1 text-sm text-muted-foreground">{description}</p>
      )}
    </div>
  );
}
