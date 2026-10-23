import type { Metadata } from "next";

import { CutLanding } from "@/app/cut/_components/landing/CutLanding";
import { DONKEYCUT_CANONICAL } from "@/cut/lib/hosts";

export const metadata: Metadata = {
  title: "Donkey Cut Video Editor — Free, Open Source CapCut Alternative",
  description:
    "A free, open source CapCut alternative. Edit with Chat, generate video, images, voiceovers and music, and keep your projects local.",
  alternates: {
    canonical: `${DONKEYCUT_CANONICAL}/`,
  },
  openGraph: {
    title: "Donkey Cut Video Editor — Free, Open Source CapCut Alternative",
    description:
      "A free, open source CapCut alternative. Edit with Chat, generate video, images, voiceovers and music, and keep your projects local.",
    url: `${DONKEYCUT_CANONICAL}/`,
    siteName: "Donkey Cut",
    type: "website",
    images: [{ url: "/cut/landing/og.png", width: 1200, height: 630 }],
  },
  twitter: {
    card: "summary_large_image",
    title: "Donkey Cut Video Editor — Free, Open Source CapCut Alternative",
    description:
      "A free, open source CapCut alternative. Edit with Chat, generate video, images, voiceovers and music, and keep your projects local.",
    images: ["/cut/landing/og.png"],
  },
};

// The public pages are the ones a visitor lands on cold, so they are the ones
// that have to be instant. Nothing here reads request data; declaring it makes
// Next check that in dev and at build, and the check is what keeps a server
// read added later from quietly turning a link click into a wait.
export const instant = true;

// The WebSite record Google reads for the site name above a result. The
// alternate name ties brand searches to the editor; "donkey cut" alone ranks
// cut-out crafts and template sites.
const WEBSITE_LD = {
  "@context": "https://schema.org",
  "@type": "WebSite",
  name: "Donkey Cut",
  alternateName: "Donkey Cut Video Editor",
  url: `${DONKEYCUT_CANONICAL}/`,
};

// The Cut marketing landing, served at "/" on every host by the proxy's
// "/…" → "/cut/…" rewrite.
export default function CutLandingPage() {
  return (
    <>
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(WEBSITE_LD) }} />
      <CutLanding />
    </>
  );
}
