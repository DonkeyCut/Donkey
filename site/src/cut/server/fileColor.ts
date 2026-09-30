/**
 * Source color read off the file on disk.
 *
 * The engine and the worker hold the media themselves, so a clip that
 * reaches them without a color record — a spec from a client that never read
 * the header, an asset imported before the probe existed — is read here with
 * the same header walk the page runs (lib/colorProbe.ts), over ranged reads
 * of the file.
 */

import { open } from "node:fs/promises";
import type { SpecClipColor } from "../lib/exportDelivery";
import { probeColor, probeMissingColors, withFoundColors, type ColorProbe } from "../lib/colorProbe";
import { pictureAssetIds, type ItemLists } from "../lib/itemKinds";

/** The color a file's header describes. */
export async function probeFileColor(filePath: string): Promise<ColorProbe> {
  const handle = await open(filePath, "r");
  try {
    const { size } = await handle.stat();
    return await probeColor(async (offset, length) => {
      const buf = new Uint8Array(Math.max(0, Math.min(length, size - offset)));
      const { bytesRead } = await handle.read(buf, 0, buf.length, offset);
      return buf.subarray(0, bytesRead);
    }, size);
  } finally {
    await handle.close();
  }
}

/** `assets` with the color record of every video the timeline draws filled
 * from its file. A drawn file whose header cannot be read fails the call,
 * naming it; files nothing on the timeline uses are not read. */
export async function withFileColors<A extends { id: string; type: string; fileName: string; color?: unknown; block?: unknown }>(
  assets: A[],
  lists: Pick<ItemLists, "clips" | "overlays">,
  pathFor: (fileName: string) => string
): Promise<A[]> {
  return withFoundColors(assets, await probeMissingColors(assets, pictureAssetIds(lists), (a) => probeFileColor(pathFor(a.fileName))));
}

type SpecSource = { file?: string; image?: boolean; staged?: boolean; color?: SpecClipColor };

/**
 * A render spec whose video sources each carry their color: a clip or video
 * overlay that arrived without one is read from its media file. Stills are
 * sRGB and staged pictures are painted by the page, so neither is read. A
 * file that is not there is left as it came: the render names it missing
 * when it reaches for it.
 */
export async function withSpecColors<S extends { clips: SpecSource[]; overlayVideos?: SpecSource[] }>(
  spec: S,
  mediaPathFor: (file: string) => string
): Promise<S> {
  const owners = [...spec.clips, ...(spec.overlayVideos ?? [])];
  const wanted = new Set(owners.filter((o) => !o.color && !o.image && !o.staged && o.file).map((o) => o.file!));
  if (wanted.size === 0) return spec;
  const colors = new Map<string, SpecClipColor>();
  await Promise.all(
    [...wanted].map(async (file) => {
      const probe = await probeFileColor(mediaPathFor(file)).catch((e: unknown) => {
        if ((e as { code?: string }).code === "ENOENT") return null;
        throw new Error(`The color of ${file} could not be read: ${e instanceof Error ? e.message : String(e)}`);
      });
      if (probe) colors.set(file, { profile: probe.detected, matrix: probe.code.matrix, fullRange: probe.code.fullRange });
    })
  );
  const fill = <T extends SpecSource>(o: T): T =>
    !o.color && o.file && colors.has(o.file) ? { ...o, color: colors.get(o.file) } : o;
  return {
    ...spec,
    clips: spec.clips.map(fill),
    ...(spec.overlayVideos ? { overlayVideos: spec.overlayVideos.map(fill) } : {}),
  } as S;
}
