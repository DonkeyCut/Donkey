import type { Metadata } from "next";

import { CutLanding } from "@/app/cut/_components/landing/CutLanding";
import { DONKEYCUT_CANONICAL } from "@/cut/lib/hosts";

export const metadata: Metadata = {
  title: "Donkey Cut — Free, Open Source Video Editor",
  description:
    "A free, open source CapCut alternative. Edit with Chat, generate video, images, voiceovers and music, and keep your projects local.",
  alternates: {
    canonical: `${DONKEYCUT_CANONICAL}/`,
  },
  openGraph: {
    title: "Donkey Cut — Free, Open Source Video Editor",
    description:
      "Edit with Chat, generate video, images, voiceovers and music, and keep your projects local. A free, open source CapCut alternative.",
    url: `${DONKEYCUT_CANONICAL}/`,
    siteName: "Donkey Cut",
    type: "website",
    images: [{ url: "/cut/landing/og.png", width: 1200, height: 630 }],
  },
  twitter: {
    card: "summary_large_image",
    title: "Donkey Cut — Free, Open Source Video Editor",
    description:
      "Edit with Chat, generate content in your timeline, and keep your projects local. Free, open source, and a CapCut alternative.",
    images: ["/cut/landing/og.png"],
  },
};

// The Cut marketing landing, served at "/" on every host by the proxy's
// "/…" → "/cut/…" rewrite.
export default function CutLandingPage() {
  return <CutLanding />;
}
