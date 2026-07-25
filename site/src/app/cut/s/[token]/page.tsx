import type { Metadata } from "next";
import { headers } from "next/headers";
import { cutAppBase } from "@/cut/lib/hosts";
import { shareMetaForToken } from "@/cut/server/cloud/shareCard";
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

/** The public path of this share, mirroring the link the Share dialog copies:
 * the app base without its /app segment. */
function sharePath(host: string | null, token: string): string {
  return `${cutAppBase(host).replace(/\/app$/, "")}/s/${encodeURIComponent(token)}`;
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
  const h = await headers();
  const base = await origin();
  const url = `${base}${sharePath(h.get("host"), token)}`;
  const card = (kind: "gif" | "jpg") => `${url}/card/${kind}?v=${meta.version}`;
  const description = `A video project shared from Donkey Cut. Watch ${meta.name} in the browser.`;
  // The GIF leads: the platforms that animate it play the opening seconds, and
  // the rest fall back to its first frame — the same picture the JPEG carries
  // for anything that would rather not take a multi-megabyte image. Either URL
  // answers before a card has rendered; the route draws one.
  const images = [
    { url: card("gif"), width: 1200, height: 630, alt: meta.name },
    { url: card("jpg"), width: 1200, height: 630, alt: meta.name },
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
  return <SharedProjectView />;
}
