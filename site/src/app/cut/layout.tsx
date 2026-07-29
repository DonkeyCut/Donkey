import type { Metadata } from "next";
import type { ReactNode } from "react";

export const metadata: Metadata = {
  title: "Donkey Cut",
  description: "A video editor that does all its work on your Mac.",
};

// Surface styling belongs to the children: the landing page at /cut renders on
// the cream marketing background, while the app subtree under /cut/app paints
// its own white product surface. The proxy serves this whole tree at "/…"
// ("/app/…" for the app) on every host.
export default function CutLayout({ children }: { children: ReactNode }) {
  return children;
}
