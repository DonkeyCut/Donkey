import { resolveShare } from "@/cut/server/cloud/sharedView";
import {
  CARD_CACHE_SECONDS,
  cardUrl,
  placeholderCard,
  shareProjectName,
  type CardKind,
} from "@/cut/server/cloud/shareCard";

// The image a shared link unfurls with. Crawlers fetch this directly, so it
// answers for the token alone with no session and no client bundle in the way.
// The version in the query string is what makes a re-share pick up a newer
// card: the bytes behind it live on a fixed R2 key.
//
// A public share's card is cacheable by anyone — the token is already the
// gate. A restricted share's is not: it 404s for anyone the share doesn't name,
// so the answer depends on the viewer's session and must stay out of shared
// caches.

export const runtime = "nodejs";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ token: string; ext: string }> }
) {
  const { token, ext } = await params;
  const view = await resolveShare(token, request);
  if (view instanceof Response) return view;
  const target = { userId: view.share.userId, projectId: view.share.projectId };
  const cacheable = view.share.access === "public";
  const headers: Record<string, string> = cacheable
    ? { "Cache-Control": `public, s-maxage=${CARD_CACHE_SECONDS}, stale-while-revalidate=86400` }
    : { "Cache-Control": "private, no-store" };

  if (ext === "gif" || ext === "jpg") {
    const url = await cardUrl(target, ext as CardKind);
    if (url) return new Response(null, { status: 302, headers: { ...headers, Location: url } });
  }

  // No card yet — draw one so the link never unfurls blank. Kept on a short
  // leash so the rendered card takes over as soon as it exists.
  const name = await shareProjectName(target);
  if (!name) return new Response("Not found.", { status: 404 });
  const image = placeholderCard(name);
  const short = cacheable ? "public, s-maxage=60, stale-while-revalidate=600" : "private, no-store";
  return new Response(image.body, {
    status: 200,
    headers: { "Content-Type": "image/png", "Cache-Control": short },
  });
}
