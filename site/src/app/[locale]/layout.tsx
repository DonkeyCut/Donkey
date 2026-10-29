import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { locale as rootLocale } from "next/root-params";
import { Suspense } from "react";
import { GeistMono } from "geist/font/mono";
import { GeistSans } from "geist/font/sans";
import { getTranslations } from "next-intl/server";
import "../globals.css";

import { DONKEYCUT_CANONICAL } from "@/cut/lib/hosts";
import { IntlScope } from "@/i18n/IntlScope";
import { LOCALES, isLocale } from "@/i18n/locales";
import { THEME_HEAD_SCRIPT } from "@/lib/theme";
import { QueryProvider } from "@/queries/QueryProvider";
import { MetaPageView } from "@/app/_components/MetaPageView";
import { PlanTermsProvider } from "@/app/_components/PlanTermsProvider";
import { cachedPlanTerms } from "@/lib/billing/plan-terms-server";
import { PostHogProvider } from "@/app/_components/PostHogProvider";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("common.meta");
  return {
    // The base every relative card and canonical URL resolves against. Left
    // unset, Next reads the request's own host to resolve them, which makes the
    // metadata of an otherwise static page request-dependent.
    metadataBase: new URL(DONKEYCUT_CANONICAL),
    title: t("title"),
    description: t("description"),
    // Declared here and served from public/ at these URLs. File-based icons —
    // favicon.ico and apple-icon.png sitting in app/ — resolve per request, which
    // makes the metadata of every page in the app request-dependent and holds
    // back its static shell.
    //
    // Every icon here is the black and white mark, and the 192px PNG is the size
    // Google's favicon crawler asks for, so the icon it picks for a search result
    // is the one we ship. The blue rounded-square icon belongs to the Mac app.
    icons: {
      icon: [
        { url: "/favicon.ico", sizes: "16x16 32x32 48x48" },
        { url: "/icon.png", type: "image/png", sizes: "192x192" },
      ],
      apple: "/apple-icon.png",
    },
  };
}

// Every page is prerendered once per locale. The proxy rewrites each request
// into its visitor's locale (src/proxy.ts), so the segment never shows in a
// URL.
export function generateStaticParams() {
  return LOCALES.map((locale) => ({ locale }));
}

export default async function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  const locale = await rootLocale();
  if (!isLocale(locale)) {
    notFound();
  }
  // Cached, so the terms are in every page's static shell.
  const planTerms = await cachedPlanTerms();
  return (
    <html
      lang={locale}
      className={`${GeistSans.variable} ${GeistMono.variable} h-full antialiased`}
      // The head script adds the saved theme's class before hydration.
      suppressHydrationWarning
    >
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_HEAD_SCRIPT }} />
      </head>
      <body className="min-h-full flex flex-col">
        <PostHogProvider>
          <QueryProvider>
            <PlanTermsProvider terms={planTerms}>
              <IntlScope namespaces={["common"]}>{children}</IntlScope>
            </PlanTermsProvider>
          </QueryProvider>
          <Suspense fallback={null}>
            <MetaPageView />
          </Suspense>
        </PostHogProvider>
      </body>
    </html>
  );
}
