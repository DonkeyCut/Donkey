/**
 * What a clip's frames mean, for the grade pipeline.
 *
 * A reader and the recipe its frames are drawn through have to agree on one
 * thing: which file is read, and how. `colorRead` answers both from the same
 * pair — the asset and the file being read, its master or its preview proxy
 * — so a reader takes its sink options and the compositor takes its recipe
 * from one value, and they cannot drift apart.
 *
 * A Rec.709 or sRGB master is drawn as it is. Any other master — Apple Log,
 * HLG, PQ — is decoded with its tags replaced by sRGB / Rec.709 at the file's
 * own range, so the browser draws code values, and the recipe names the
 * file's own matrix beside the one the decoder drew with (`decodePath`,
 * decoderCheck.ts, measured per route and range), so the source stage can
 * undo the drawn matrix before the profile conversion. A preview proxy is
 * tagged Rec.709 limited and needs neither.
 */

import type { DrawnColor, SourceProfile } from "@donkeycut/effects-kit";
import { decodeOverrideFor, decodePath, decodePathNow, type DecodeRoute } from "./decoderCheck";
import { frameSinkIsCustom } from "./mediaRead";
import type { MediaAsset, StoredAsset } from "./types";

export type { DecodeRoute } from "./decoderCheck";

/** Which of an asset's files a reader reads. */
export type ReadFile = "master" | "proxy";

type ColorOf = Pick<MediaAsset, "color" | "colorProfile">;

export interface RecipeInput extends DrawnColor {
  profile: SourceProfile;
}

/** How one reader reads an asset's frames, and what those frames mean. */
export interface ColorRead {
  /** The color space the reader's sink tags frames with; undefined draws the
   * file as it is tagged. */
  colorSpace: VideoColorSpaceInit | undefined;
  /** The recipe's source fields for these frames now. While the route's
   * measurement runs the drawn matrix is taken as the file's own, and the
   * recipe key changes once it settles. */
  recipe(): RecipeInput;
  /** The recipe once the route's drawn matrix is measured: what a job that
   * needs the exact picture from its first frame waits on. */
  settled(): Promise<RecipeInput>;
}

const REC709_LIMITED: DrawnColor = { matrix: "bt709", fullRange: false, drawnMatrix: "bt709", drawnFullRange: false };

/** What a source's code values mean: the person's override, else what the
 * header said, else Rec.709 for media imported before the probe existed. */
export function sourceProfileOf(asset: Pick<StoredAsset, "color" | "colorProfile"> | undefined | null): SourceProfile {
  return asset?.colorProfile ?? asset?.color?.detected ?? "rec709";
}

/** The file the preview reads: the proxy once there is one. */
export const previewFile = (asset: Pick<MediaAsset, "proxyUrl">): ReadFile => (asset.proxyUrl ? "proxy" : "master");

/** The file a URL of the asset names. */
export const fileAt = (asset: Pick<MediaAsset, "proxyUrl">, url: string): ReadFile =>
  asset.proxyUrl !== undefined && url === asset.proxyUrl ? "proxy" : "master";

/** The route a master's frames take in this process. */
function routeOf(asset: ColorOf): DecodeRoute {
  if (frameSinkIsCustom()) return "headless";
  if (asset.color?.codec?.startsWith("ap")) return "prores";
  return "webcodecs";
}

const fixedRead = (input: RecipeInput): ColorRead => ({
  colorSpace: undefined,
  recipe: () => input,
  settled: () => Promise.resolve(input),
});
/** A source whose header was never read: its code values are taken as
 * Rec.709 limited, meaning whatever profile it is set to. */
const unprobed: Partial<Record<SourceProfile, ColorRead>> = {};
/** Reads by header record, then file and profile: the compositor asks per
 * clip per frame, and a record is replaced whole whenever it changes. */
const reads = new WeakMap<object, Partial<Record<ReadFile, Partial<Record<SourceProfile, ColorRead>>>>>();

/** How `file` of `asset` is read in this process, and what its frames mean. */
export function colorRead(asset: ColorOf, file: ReadFile): ColorRead {
  const color = asset.color;
  const profile = sourceProfileOf(asset);
  if (!color) return (unprobed[profile] ??= fixedRead({ profile, ...REC709_LIMITED }));
  let held = reads.get(color);
  if (!held) reads.set(color, (held = {}));
  const byProfile = (held[file] ??= {});
  return (byProfile[profile] ??= readOf(asset, file, profile));
}

function readOf(asset: ColorOf, file: ReadFile, profile: SourceProfile): ColorRead {
  const color = asset.color;
  if (file === "proxy" || !color) {
    return fixedRead({ profile, ...REC709_LIMITED });
  }
  const own = { matrix: color.matrix, fullRange: color.fullRange };
  const asTagged: RecipeInput = { profile, ...own, drawnMatrix: own.matrix, drawnFullRange: own.fullRange };
  if (profile === "rec709" || profile === "srgb") return fixedRead(asTagged);
  const route = routeOf(asset);
  let measured: RecipeInput | null = null;
  const drawn = (path: ReturnType<typeof decodePathNow>): RecipeInput => {
    if (measured) return measured;
    if (!path) return asTagged;
    measured =
      path.kind === "code" ? { profile, ...own, drawnMatrix: path.drawnMatrix, drawnFullRange: path.drawnFullRange } : asTagged;
    return measured;
  };
  return {
    colorSpace: decodeOverrideFor(route, own.fullRange),
    recipe: () => measured ?? drawn(decodePathNow(route, own.fullRange)),
    settled: () => decodePath(route, own.fullRange).then(drawn),
  };
}

/** Whether two color records read the same picture from the same file: the
 * same sink tag and the same recipe. Both go through the same route at the
 * same range whenever the tags match, so the drawn matrix is theirs alike. */
export function sameColorRead(a: ColorOf, b: ColorOf, file: ReadFile): boolean {
  const ra = colorRead(a, file);
  const rb = colorRead(b, file);
  if (JSON.stringify(ra.colorSpace) !== JSON.stringify(rb.colorSpace)) return false;
  const x = ra.recipe();
  const y = rb.recipe();
  return (
    x.profile === y.profile &&
    x.matrix === y.matrix &&
    x.fullRange === y.fullRange &&
    x.drawnMatrix === y.drawnMatrix &&
    x.drawnFullRange === y.drawnFullRange
  );
}
