import type { Metadata } from "next";
import type { ReactNode } from "react";

import { SuShell } from "@/app/su/SuShell";

// The super-user section, served on its own host (src/proxy.ts maps
// su.donkeycut.com onto this tree). It sits outside the Cut app's layout so
// none of the product shell — the engine connection gate, the exports dock,
// the welcome sequence — mounts on an admin page.
export const metadata: Metadata = {
  robots: { follow: false, index: false },
  title: "Super user",
};

export default function SuLayout({ children }: { children: ReactNode }) {
  return <SuShell>{children}</SuShell>;
}
