import type { Metadata } from "next";

import { Footer } from "@/app/_components/landing/Footer";
import { TopNav } from "@/app/_components/landing/TopNav";
import { ApiSection } from "@/app/donkeyvision/ApiSection";
import { HeroSection } from "@/app/donkeyvision/HeroSection";
import { MediaSection } from "@/app/donkeyvision/MediaSection";
import { PricingSection } from "@/app/donkeyvision/PricingSection";
import { ProofSection } from "@/app/donkeyvision/ProofSection";
import { UseCasesSection } from "@/app/donkeyvision/UseCasesSection";
import { VisionCompareSection } from "@/app/donkeyvision/VisionCompareSection";

export const dynamic = "force-static";

export const metadata: Metadata = {
  title: "OmniParser API for UI Element Detection | Donkey Vision",
  description:
    "Donkey Vision is a fast, OmniParser-compatible API for detecting interactable UI elements in screenshots — bounding boxes, center points, and labels.",
  keywords: [
    "OmniParser API",
    "OmniParser",
    "OmniParser-compatible API",
    "UI element detection API",
    "screenshot UI parsing API",
    "computer use vision API",
    "Donkey Vision",
  ],
  alternates: {
    canonical: "https://donkeycut.com/donkeyvision",
  },
  openGraph: {
    type: "website",
    url: "https://donkeycut.com/donkeyvision",
    siteName: "Donkey",
    title: "OmniParser API for UI Element Detection | Donkey Vision",
    description:
      "Donkey Vision is a fast, OmniParser-compatible API for detecting interactable UI elements in screenshots — bounding boxes, center points, and labels.",
  },
  twitter: {
    card: "summary_large_image",
    title: "OmniParser API for UI Element Detection | Donkey Vision",
    description:
      "Donkey Vision is a fast, OmniParser-compatible API for detecting interactable UI elements in screenshots — bounding boxes, center points, and labels.",
  },
};

const structuredData = {
  "@context": "https://schema.org",
  "@type": "WebAPI",
  name: "Donkey Vision",
  alternateName: "OmniParser API",
  url: "https://donkeycut.com/donkeyvision",
  description:
    "Donkey Vision is a fast, OmniParser-compatible API for detecting interactable UI elements in screenshots — bounding boxes, center points, and labels.",
  provider: {
    "@type": "Organization",
    name: "Donkey",
    url: "https://donkeycut.com",
  },
};

export default function DonkeyVisionPage() {
  return (
    <main className="min-h-screen w-full overflow-x-clip bg-[#F5EFE0] font-[-apple-system,BlinkMacSystemFont,'Segoe_UI',sans-serif] text-[#0F0E0D]">
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(structuredData) }}
      />
      <TopNav wordmark="Donkey Vision" />
      <HeroSection />
      <ProofSection />
      <VisionCompareSection />
      <ApiSection />
      <UseCasesSection />
      <MediaSection />
      <PricingSection />
      <Footer />
    </main>
  );
}
