import { ChartColumn, CreditCard, ListChecks, Mail, UserRound } from "lucide-react";
import type { ComponentType } from "react";

import { RunAnalyticsButton } from "@/app/su/analytics/RunAnalyticsButton";
import { ScanOutreachButton } from "@/app/su/outreach/ScanOutreachButton";

// The super-user surfaces in rail order, addressed from the root of their own
// host. One entry carries everything a surface is drawn from — the rail's tab,
// the header's title and action — so adding a surface is one edit here and a
// page.tsx. The section root lands on the first entry, so reordering this list
// moves where the host opens.
export type SuSurface = {
  href: string;
  label: string;
  icon: typeof UserRound;
  title: string;
  description?: string;
  Action?: ComponentType;
};

export const SU_NAV: SuSurface[] = [
  {
    href: "/analytics",
    label: "Analytics",
    icon: ChartColumn,
    title: "Analytics",
    description: "Product analytics.",
    Action: RunAnalyticsButton,
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
    href: "/jobs",
    label: "Jobs",
    icon: ListChecks,
    title: "Jobs",
    description: "Background work started from these surfaces, newest first.",
  },
];
