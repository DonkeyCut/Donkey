"use client";

import { usePathname } from "next/navigation";

import { cn } from "@/lib/utils";

// Ordered so the more specific path wins the suffix match. Billing pins its
// title while the cards scroll; usage lets the title scroll away so the
// table's own pinned column header takes the top of the pane.
const SECTIONS = [
  {
    suffix: "/settings/usage",
    title: "Usage",
    description: "Your AI generation usage this billing period.",
    pinned: false,
  },
  {
    suffix: "/settings/profile",
    title: "Profile",
    pinned: true,
  },
  {
    suffix: "/settings",
    title: "Billing",
    description: "Your subscription and credit balance.",
    pinned: true,
  },
];

export function SettingsHeader() {
  const pathname = usePathname();
  // Billing is the settings root, so it's also the fallback title.
  const section =
    SECTIONS.find((s) => pathname.endsWith(s.suffix)) ?? SECTIONS.at(-1)!;
  return (
    <div
      className={cn(
        "mx-auto w-full max-w-6xl shrink-0 px-10 pt-9 pb-5",
        section.pinned && "sticky top-0 z-20 bg-background",
      )}
    >
      <h1 className="text-lg font-semibold tracking-tight">{section.title}</h1>
      {section.description && (
        <p className="mt-1 text-sm text-muted-foreground">{section.description}</p>
      )}
    </div>
  );
}
