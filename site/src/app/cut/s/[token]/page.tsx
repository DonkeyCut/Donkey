import type { Metadata } from "next";
import { headers } from "next/headers";
import { shareMetaForToken } from "@/cut/server/cloud/shareCard";
import { NoSessionReplay } from "@/app/_components/NoSessionReplay";
import { SharedProjectView } from "./SharedProjectView";

// The share page is a client view — it fetches its own access decision and
// mounts the editor read-only — but the document around it is server-rendered,
// which is the only thing a link crawler ever sees. So the title, description,
// and card come from here.
//
// Only a public share describes itself. A restricted share is a link that
// means nothing without the right account, so it unfurls as a neutral invite
// and stays out of search: naming the project there would leak it to anyone
// holding the URL.

/** Absolute origin for this request — card URLs must be absolute for crawlers. */
async function origin(): Promise<string> {
  const h = await headers();
  const host = h.get("host") ?? "donkeycut.com";
  const proto = h.get("x-forwarded-proto") ?? (host.startsWith("localhost") ? "http" : "https");
  return `${proto}://${host}`;
}

/** The public path of this share, mirroring the link the Share dialog copies. */
function sharePath(token: string): string {
  return `/s/${encodeURIComponent(token)}`;
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ token: string }>;
}): Promise<Metadata> {
  const { token } = await params;
  const meta = await shareMetaForToken(token);
  if (!meta || !meta.isPublic) {
    return {
      title: "Shared project · Donkey Cut",
      description: "This project is shared with specific people.",
      robots: { index: false, follow: false },
    };
  }
  const base = await origin();
  const url = `${base}${sharePath(token)}`;
  const card = (kind: "gif" | "jpg") => `${url}/card/${kind}?v=${meta.version}`;
  const description = `A video project shared from Donkey Cut. Watch ${meta.name} in the browser.`;
  // The GIF leads: the platforms that animate it play the opening seconds, and
  // the rest fall back to its first frame — the same picture the JPEG carries
  // for anything that would rather not take a multi-megabyte image. Either URL
  // answers before a card has rendered; the route draws one.
  //
  // No declared dimensions: a card is the cut's own shape (a portrait project
  // unfurls portrait) and the drawn placeholder is 1.91:1, so any number here
  // would be wrong for some shares and platforms lay out against it.
  const images = [
    { url: card("gif"), alt: meta.name },
    { url: card("jpg"), alt: meta.name },
  ];
  return {
    title: `${meta.name} · Donkey Cut`,
    description,
    alternates: { canonical: url },
    openGraph: {
      type: "video.other",
      title: meta.name,
      description,
      url,
      siteName: "Donkey Cut",
      images,
    },
    twitter: {
      card: "summary_large_image",
      title: meta.name,
      description,
      images: images.map((i) => i.url),
    },
  };
}

export default function SharedProjectPage() {
  return (
    <>
      <NoSessionReplay />
      {/* Same reason the app subtree is marked (app/cut/app/layout.tsx): a
          browser's translator rewriting text nodes under this tree breaks
          hydration and then a later commit. `contents` keeps the wrapper out
          of the layout the view below sets up. */}
      <div translate="no" className="contents">
        <SharedProjectView />
      </div>
    </>
  );
}
