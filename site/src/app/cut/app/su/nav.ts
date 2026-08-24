import { ChartColumn, CreditCard, Mail, UserRound } from "lucide-react";

// The super-user surfaces in rail order. The section root lands on the first
// one, so reordering this list moves where /app/su opens.
export const SU_NAV: { suffix: string; label: string; icon: typeof UserRound }[] = [
  { suffix: "/analytics", label: "Analytics", icon: ChartColumn },
  { suffix: "/users", label: "Users", icon: UserRound },
  { suffix: "/credits", label: "Credits", icon: CreditCard },
  { suffix: "/outreach", label: "Outreach", icon: Mail },
];
