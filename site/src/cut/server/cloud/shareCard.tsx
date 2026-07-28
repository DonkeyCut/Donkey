// The share card: the image a link to a shared project unfurls with.
//
// The render worker derives two artifacts from the cut's opening seconds — a
// still of the first frame and an animated GIF — and stores them on fixed R2
// keys. Freshness rides the public URL, which carries the doc version, so a
// crawler that has seen one version asks again for the next while the bytes
// stay one object per project.
//
// Until a card has rendered (a link shared seconds ago, a project shared
// before cards existed) the page still needs something to point at, so this
// also draws the placeholder: the project's name on Cut's own backdrop.
import { ImageResponse } from "next/og";
import { prisma } from "@/lib/prisma";
import { MediaNotConfiguredError, mediaObjectUrl } from "./mediaCdn";
import { head, projectCardKey } from "./r2";

export type CardKind = "gif" | "jpg";

/** OG's 1.91:1, the size every platform crops toward. */
const CARD_WIDTH = 1200;
const CARD_HEIGHT = 630;
/** A card URL names its version, so a crawler holding one can be handed the
 * edge copy for as long as the signature behind it lives. */
export const CARD_CACHE_SECONDS = 45 * 60;
/** How long past that a crawler may be served the cached redirect while it
 * revalidates behind the request. A token in that redirect has to outlast the
 * whole window, or the card unfurls broken hours after it was minted. */
export const CARD_STALE_SECONDS = 24 * 60 * 60;

export interface ShareCardTarget {
  userId: string;
  projectId: string;
}

/** A signed URL for one stored artifact, or null when it hasn't rendered.
 * Storage being unreachable reads the same as no card — the route draws one
 * rather than failing. */
export async function cardUrl(
  target: ShareCardTarget,
  kind: CardKind
): Promise<string | null> {
  try {
    const key = projectCardKey(target.userId, target.projectId, kind);
    const object = await head(key);
    if (!object) return null;
    // The card lives on a fixed key that every re-render overwrites, so its
    // ETag is what keeps the edge from serving the previous one.
    return mediaObjectUrl(key, {
      version: object.etag,
      minLifetimeSeconds: CARD_CACHE_SECONDS + CARD_STALE_SECONDS,
    });
  } catch (e) {
    // A card that isn't there yet is ordinary — the caller draws a placeholder.
    // A deployment with no signing secret is not, and must not hide behind it.
    if (e instanceof MediaNotConfiguredError) throw e;
    return null;
  }
}

/** The project's display name for the card and the page title. */
export async function shareProjectName(target: ShareCardTarget): Promise<string | null> {
  const row = await prisma.cutProject.findFirst({
    where: { id: target.projectId, userId: target.userId },
    select: { name: true },
  });
  return row?.name ?? null;
}

export interface ShareMeta {
  name: string;
  /** Doc version, so a card URL changes when the cut does. */
  version: number;
  isPublic: boolean;
}

/** Everything the share page's document needs, read straight from the rows —
 * two indexed lookups and no storage round trip, because this runs on every
 * viewer's page load, not just a crawler's. Whether a card has actually
 * rendered is the card route's business: it draws one when it hasn't.
 *
 * A restricted share resolves far enough to know it is restricted and no
 * further — the page describes those without naming them. */
export async function shareMetaForToken(token: string): Promise<ShareMeta | null> {
  if (!token || token.length > 64) return null;
  const share = await prisma.cutProjectShare.findUnique({
    where: { id: token },
    select: { projectId: true, userId: true, access: true },
  });
  if (!share) return null;
  const project = await prisma.cutProject.findFirst({
    where: { id: share.projectId, userId: share.userId },
    select: { name: true, version: true },
  });
  if (!project) return null;
  return { name: project.name, version: project.version, isPublic: share.access === "public" };
}

/** The stand-in card, drawn rather than rendered: no ffmpeg runs on the hosted
 * side, so this is what a link shows in the seconds before its first card
 * lands. */
export function placeholderCard(name: string): ImageResponse {
  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          flexDirection: "column",
          justifyContent: "flex-end",
          padding: 72,
          background: "linear-gradient(135deg, #0b0b0f 0%, #1b1a24 55%, #2a2333 100%)",
          color: "#fff",
        }}
      >
        <div style={{ display: "flex", fontSize: 30, letterSpacing: 2, opacity: 0.6 }}>
          DONKEY CUT
        </div>
        <div
          style={{
            display: "flex",
            fontSize: 68,
            fontWeight: 700,
            lineHeight: 1.1,
            marginTop: 16,
            // Two lines of a long project name, then an ellipsis.
            maxHeight: 150,
            overflow: "hidden",
          }}
        >
          {name}
        </div>
        <div style={{ display: "flex", fontSize: 28, marginTop: 20, opacity: 0.65 }}>
          Shared video project
        </div>
      </div>
    ),
    { width: CARD_WIDTH, height: CARD_HEIGHT }
  );
}
