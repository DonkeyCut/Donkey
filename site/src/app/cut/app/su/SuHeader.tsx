"use client";

import { usePathname } from "next/navigation";
import type { ComponentType } from "react";

import { RunAnalyticsButton } from "@/app/cut/app/su/analytics/RunAnalyticsButton";
import { ScanOutreachButton } from "@/app/cut/app/su/outreach/ScanOutreachButton";

// Every surface owns a path, so the match is exact; the rail's order is the
// order here, and its first entry is what the section root opens.
const SECTIONS: {
  suffix: string;
  title: string;
  description: string;
  Action?: ComponentType;
}[] = [
  {
    suffix: "/su/analytics",
    title: "Analytics",
    description: "Product analytics.",
    Action: RunAnalyticsButton,
  },
  {
    suffix: "/su/users",
    title: "Users",
    description: "Account actions.",
  },
  {
    suffix: "/su/credits",
    title: "Credits",
    description: "Grant credits to a user.",
  },
  {
    suffix: "/su/outreach",
    title: "Outreach",
    description: "Free accounts spending credits, and where each conversation stands.",
    Action: ScanOutreachButton,
  },
];

export function SuHeader() {
  const pathname = usePathname();
  const section =
    SECTIONS.find((s) => pathname.endsWith(s.suffix)) ?? SECTIONS[0];
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
