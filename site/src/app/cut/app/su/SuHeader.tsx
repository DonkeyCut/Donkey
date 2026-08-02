"use client";

import { usePathname } from "next/navigation";
import type { ComponentType } from "react";

import { RunAnalyticsButton } from "@/app/cut/app/su/analytics/RunAnalyticsButton";

// Ordered so the more specific path wins the suffix match; Users is the
// section root, so it's also the fallback title.
const SECTIONS: {
  suffix: string;
  title: string;
  description: string;
  Action?: ComponentType;
}[] = [
  {
    suffix: "/su/credits",
    title: "Credits",
    description: "Grant credits to a user.",
  },
  {
    suffix: "/su/analytics",
    title: "Analytics",
    description: "Product analytics.",
    Action: RunAnalyticsButton,
  },
  {
    suffix: "/su",
    title: "Users",
    description: "Account actions.",
  },
];

export function SuHeader() {
  const pathname = usePathname();
  const section =
    SECTIONS.find((s) => pathname.endsWith(s.suffix)) ?? SECTIONS.at(-1)!;
  return (
    <div className="sticky top-0 z-20 mx-auto flex w-full max-w-6xl shrink-0 items-start justify-between gap-4 bg-background px-10 pt-9 pb-5">
      <div>
        <h1 className="text-lg font-semibold tracking-tight">{section.title}</h1>
        <p className="mt-1 text-sm text-muted-foreground">{section.description}</p>
      </div>
      {section.Action ? <section.Action /> : null}
    </div>
  );
}
