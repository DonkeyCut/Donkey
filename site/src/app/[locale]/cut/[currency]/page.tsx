import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";

import { CutLanding } from "@/app/[locale]/cut/_components/landing/CutLanding";
import { DONKEYCUT_CANONICAL } from "@/cut/lib/hosts";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("landing.meta");
  const title = t("title");
  const description = t("description");
  return {
    title,
    description,
    alternates: {
      canonical: `${DONKEYCUT_CANONICAL}/`,
    },
    openGraph: {
      title,
      description,
      url: `${DONKEYCUT_CANONICAL}/`,
      siteName: "Donkey Cut",
      type: "website",
      images: [{ url: "/cut/landing/og.png", width: 1200, height: 630 }],
    },
    twitter: {
      card: "summary_large_image",
      title,
      description,
      images: ["/cut/landing/og.png"],
    },
  };
}

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
