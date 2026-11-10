import type { Metadata } from "next";
import { headers } from "next/headers";
import { getLocale, getTranslations } from "next-intl/server";
import { NoSessionReplay } from "@/app/_components/NoSessionReplay";
import { localized, templatePoster } from "@/cut/lib/templateGallery";
import { readTemplateIndex } from "@/cut/server/cloud/templates";
import { TemplateDetailView } from "./TemplateDetailView";

// A template's public page: the template playing in the read-only editor, with
// the button that makes it the visitor's own project. The document around it
// is server-rendered for link previews.

/** Absolute origin for this request; card URLs must be absolute for crawlers. */
async function origin(): Promise<string> {
  const h = await headers();
  const host = h.get("host") ?? "donkeycut.com";
  const proto = h.get("x-forwarded-proto") ?? (host.startsWith("localhost") ? "http" : "https");
  return `${proto}://${host}`;
}
export async function generateMetadata({ params }: { params: Promise<{ id: string }> }): Promise<Metadata> {
  const { id } = await params;
  const template = (await readTemplateIndex()).templates.find((t) => t.id === decodeURIComponent(id));
  const t = await getTranslations("home.templates");
  if (!template) {
    return { title: t("title"), robots: { index: false, follow: false } };
  }
  const locale = await getLocale();
  const name = localized(template.name, locale);
  const description = localized(template.description, locale);
  return {
    title: `${name} · Donkey Cut`,
    description,
    openGraph: { title: name, description, siteName: "Donkey Cut", images: [{ url: `${await origin()}${templatePoster(template)}`, alt: name }] },
  };
}

export default function TemplatePage() {
  return (
    <>
      <NoSessionReplay />
      {/* Same reason the share page marks its tree: a browser's translator
          rewriting text nodes under the editor breaks hydration. */}
      <div translate="no" className="contents">
        <TemplateDetailView />
      </div>
    </>
  );
}
