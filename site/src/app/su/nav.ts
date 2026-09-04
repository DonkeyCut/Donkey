import { ChartColumn, CreditCard, FlaskConical, ListChecks, Mail, UserRound } from "lucide-react";
import type { ComponentType } from "react";

import { RunAnalyticsButton } from "@/app/su/analytics/RunAnalyticsButton";
import { ScanOutreachButton } from "@/app/su/outreach/ScanOutreachButton";

// The super-user surfaces in rail order, addressed from the root of their own
// host. One entry carries everything a surface is drawn from — the rail's tab,
// the header's title and action — so adding a surface is one edit here and a
// page.tsx. The section root lands on the first entry, so reordering this list
// moves where the host opens.
//
// A surface with tabs is a section: its href is a folder, each tab is a page
// under it, and the section's own page redirects to the first tab. The rail
// opens the tabs beneath the section while any of them is showing.
export type SuTab = {
  href: string;
  label: string;
  description?: string;
  Action?: ComponentType;
};

export type SuSurface = SuTab & {
  icon: typeof UserRound;
  title: string;
  tabs?: SuTab[];
};

export const SU_NAV: SuSurface[] = [
  {
    href: "/analytics",
    label: "Analytics",
    icon: ChartColumn,
    title: "Analytics",
    tabs: [
      { href: "/analytics/product", label: "Product", Action: RunAnalyticsButton },
      { href: "/analytics/social", label: "Social" },
    ],
  },
  {
    href: "/users",
    label: "Users",
    icon: UserRound,
    title: "Users",
    description: "Account actions.",
  },
  {
    href: "/credits",
    label: "Credits",
    icon: CreditCard,
    title: "Credits",
    description: "Grant credits to a user.",
  },
  {
    href: "/outreach",
    label: "Outreach",
    icon: Mail,
    title: "Outreach",
    Action: ScanOutreachButton,
  },
  {
    href: "/experiments",
    label: "Experiments",
    icon: FlaskConical,
    title: "Experiments",
    tabs: [
      {
        href: "/experiments/list",
        label: "Experiments",
        description: "Variants over settings, assigned once per account and kept.",
      },
      {
        href: "/experiments/settings",
        label: "Settings",
        description: "Every runtime setting, with its default from code and its override here.",
      },
    ],
  },
  {
    href: "/jobs",
    label: "Jobs",
    icon: ListChecks,
    title: "Jobs",
    description: "Background work started from these surfaces, newest first.",
  },
];

// The surface an address belongs to, and the tab within it when the surface
// has tabs. A section address (`/analytics`) resolves to its first tab, the
// one its page redirects to; an address outside the rail falls back to the
// entry the section root opens.
export function suSurfaceAt(pathname: string): { surface: SuSurface; tab: SuTab } {
  const surface =
    SU_NAV.find((s) => pathname === s.href || pathname.startsWith(`${s.href}/`)) ??
    SU_NAV[0];
  const tab = surface.tabs?.find((t) => t.href === pathname) ?? surface.tabs?.[0] ?? surface;
  return { surface, tab };
}
