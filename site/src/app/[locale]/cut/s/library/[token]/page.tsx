import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { Suspense } from "react";
import { NoSessionReplay } from "@/app/_components/NoSessionReplay";
import { SharedLibraryView } from "@/cut/components/SharedLibraryView";
import { librarySharePath } from "@/cut/lib/librarySharing";
import { librarySharing } from "@/cut/server/cloud/librarySharing";
import { requestOrigin } from "@/cut/server/cloud/shareCard";

// The document around the client view is server-rendered, which is all a link
// crawler sees. A public share unfurls with its item's name and picture: a
// video's first frame, an image itself. A restricted share stays a neutral
// invite and out of search, so the URL never names what it holds.

export async function generateMetadata({ params }: { params: Promise<{ token: string }> }): Promise<Metadata> {
  const { token } = await params;
  const [meta, t] = await Promise.all([librarySharing.meta(token), getTranslations("share.meta")]);
  if (!meta?.isPublic) {
    return {
      title: t("libraryTitle"),
      ...(meta ? { description: t("libraryRestrictedDescription") } : {}),
      robots: { index: false, follow: false },
    };
  }
  const url = `${await requestOrigin()}${librarySharePath(token)}`;
  const image = { url: `${url}/card?v=${meta.version}`, alt: meta.name };
  const description = meta.type === "video" ? t("description", { name: meta.name }) : t("libraryDescription", { name: meta.name });
  return {
    title: t("title", { name: meta.name }),
    description,
    alternates: { canonical: url },
    robots: { index: false, follow: false },
    openGraph: {
      type: meta.type === "video" ? "video.other" : "website",
      title: meta.name,
      description,
      url,
      siteName: "Donkey Cut",
      images: [image],
    },
    twitter: { card: "summary_large_image", title: meta.name, description, images: [image.url] },
  };
}

export default function SharedLibraryPage() {
  return <><NoSessionReplay /><Suspense><SharedLibraryView /></Suspense></>;
}
