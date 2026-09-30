/**
 * What this runtime's decoders draw when asked for code values.
 *
 * A log or HDR master is read with a color space override (mediaRead.ts
 * `FrameSinkOptions.colorSpace`): the file's tags are replaced by sRGB /
 * Rec.709 limited, in the decoder config and inside the bitstream's own SPS,
 * so the browser neither tone-maps an HLG file nor converts a wide-gamut one.
 * The picture it draws is then the file's Y'CbCr through whatever matrix the
 * decoder honored — the rewritten Rec.709 tag on most routes, BT.601 on
 * Chrome's 10-bit 4:2:2 path — and the grade pipeline undoes that matrix
 * (`DrawnColor`, effects-kit colorPipeline.ts). Each decode route is measured
 * once per session and per range the override names, on a one-frame,
 * four-tile fixture: the drawn tiles are matched against the code values
 * through every matrix and range, and the nearest wins. A decoder may honor
 * the full-range flag or ignore it, so a full-range master is read through
 * what the full-range override measured. A route whose picture matches none
 * was converted anyway.
 */

import { decodeYcc, type CodeFormat } from "@donkeycut/effects-kit";
import { frameSink, openMedia, videoTrackOf } from "./mediaRead";
import { ensureProresDecoder } from "./proresDecoder";

/** How a track's frames reach the page: a WebCodecs decoder for H.264 / HEVC
 * and the other browser codecs, the WASM ProRes decoder, or the process's
 * own decoder when a headless runner installed one (sourceColor.ts picks
 * the route for an asset). */
export type DecodeRoute = "webcodecs" | "prores" | "headless";

export type DecodePathResult =
  /** Code values, drawn through this matrix and range. */
  | { kind: "code"; drawnMatrix: CodeFormat["matrix"]; drawnFullRange: boolean }
  /** The file's own matrix and range, untouched (headless decoders). */
  | { kind: "source" }
  /** The override was ignored and the picture converted; read a proxy. */
  | { kind: "converted" };

interface Fixture {
  base64: string;
  mime: string;
  /** Y'CbCr at the four tile centers, each on [0,1] of its scale. */
  codes: readonly (readonly [number, number, number])[];
}

/** 64×64, one frame, H.264 Main tagged bt2020 / arib-std-b67 / bt2020nc,
 * limited range. Four flat tiles. */
const H264_HLG: Fixture = {
  base64:
    "AAAAIGZ0eXBpc29tAAACAGlzb21pc28yYXZjMW1wNDEAAAMabW9vdgAAAGxtdmhkAAAAAAAAAAAAAAAAAAAD6AAAACIAAQAAAQAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAgAAAkV0cmFrAAAAXHRraGQAAAADAAAAAAAAAAAAAAABAAAAAAAAACIAAAAAAAAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAABAAAAAAEAAAABAAAAAAAAkZWR0cwAAABxlbHN0AAAAAAAAAAEAAAAiAAAAAAABAAAAAAG9bWRpYQAAACBtZGhkAAAAAAAAAAAAAAAAAAA8AAAAAgBVxAAAAAAALWhkbHIAAAAAAAAAAHZpZGUAAAAAAAAAAAAAAABWaWRlb0hhbmRsZXIAAAABaG1pbmYAAAAUdm1oZAAAAAEAAAAAAAAAAAAAACRkaW5mAAAAHGRyZWYAAAAAAAAAAQAAAAx1cmwgAAAAAQAAAShzdGJsAAAAxHN0c2QAAAAAAAAAAQAAALRhdmMxAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAAAAEAAQABIAAAASAAAAAAAAAABH0xhdmM2MS4xOS4xMDEgaDI2NF92aWRlb3Rvb2xib3gAGP//AAAAJ2F2Y0MBTQAL/+EAECdNAAurQYbwIMIzUJEgkCABAAQo7jyAAAAAE2NvbHJuY2x4AAIAAgAJAAAAABBwYXNwAAAAAQAAAAEAAAAUYnRydAAAAAAAAJUQAACVEAAAABhzdHRzAAAAAAAAAAEAAAABAAACAAAAABxzdHNjAAAAAAAAAAEAAAABAAAAAQAAAAEAAAAUc3RzegAAAAAAAACfAAAAAQAAABRzdGNvAAAAAAAAAAEAAANKAAAAYXVkdGEAAABZbWV0YQAAAAAAAAAhaGRscgAAAAAAAAAAbWRpcmFwcGwAAAAAAAAAAAAAAAAsaWxzdAAAACSpdG9vAAAAHGRhdGEAAAABAAAAAExhdmY2MS43LjEwMAAAAAhmcmVlAAAAp21kYXQAAAA7BgUyR1ZK3FxMQz+U78URPNFDqAEAAAMAAQMAAAMAAQIAAeYACwAAAwAAAwAAAwGaDAOJKAEN/////4AAAABcJbggH7gVWFA+XJt3fYfLvbZyD9goKjzUORp5UAEPi6t1Upz3k/qQpq6LHdk5Q9uIvzmp5qmxsyDADd2gh4TlwwfWnsBiU1spQZPGFNnA0SWQFUAAai1ugoAypEw=",
  mime: "video/mp4",
  codes: [
    [135 / 255, 91 / 255, 157 / 255],
    [113 / 255, 164 / 255, 97 / 255],
    [124 / 255, 128 / 255, 128 / 255],
    [206 / 255, 128 / 255, 128 / 255],
  ],
};

/** The same four tiles as ProRes 422 10-bit, tagged bt2020 / arib-std-b67 /
 * bt2020nc, limited range. */
const PRORES_HLG: Fixture = {
  base64: "AAAAFGZ0eXBxdCAgAAACAHF0ICAAAAAId2lkZQAAAQZtZGF0AAAA/mljcGYAlAAATGF2YwBAAECAAAICCQAAAwQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQFBAQEBAQEBQUEBAQEBAUFBgQEBAQFBQYHBAQEBAUGBwcEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBQQEBAQEBAUFBAQEBAQFBQYEBAQEBQUGBwQEBAQFBgcHQAAAAGIABDAAGAAYABEAETAEAAYABicj8ArkfgmeMAJKxggiMAexGDAEAAYABicj8ArkfgmeMAJKxggiMAexGDAEAAcAAlOPwApbH4CCP4I/MAQABwACU4/AClsfgII/gj8AAALTbW9vdgAAAGxtdmhkAAAAAAAAAAAAAAAAAAAD6AAAACIAAQAAAQAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAgAAAj90cmFrAAAAXHRraGQAAAADAAAAAAAAAAAAAAABAAAAAAAAACIAAAAAAAAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAABAAAAAAEAAAABAAAAAAAAkZWR0cwAAABxlbHN0AAAAAAAAAAEAAAAiAAAAAAABAAAAAAG3bWRpYQAAACBtZGhkAAAAAAAAAAAAAAAAAAA8AAAAAgB//wAAAAAALWhkbHIAAAAAbWhscnZpZGUAAAAAAAAAAAAAAAAMVmlkZW9IYW5kbGVyAAABYm1pbmYAAAAUdm1oZAAAAAEAAAAAAAAAAAAAACxoZGxyAAAAAGRobHJ1cmwgAAAAAAAAAAAAAAAAC0RhdGFIYW5kbGVyAAAAJGRpbmYAAAAcZHJlZgAAAAAAAAABAAAADHVybCAAAAABAAAA9nN0YmwAAACSc3RzZAAAAAAAAAABAAAAgmFwY2gAAAAAAAAAAQAAAABGRk1QAAACAAAAAgAAQABAAEgAAABIAAAAAAAAAAEXTGF2YzYxLjE5LjEwMSBwcm9yZXNfa3MAAAAAAAAAAAAY//8AAAAKZmllbAEAAAAAEmNvbHJuY2xjAAIAAgAJAAAAEHBhc3AAAAABAAAAAQAAABhzdHRzAAAAAAAAAAEAAAABAAACAAAAABxzdHNjAAAAAAAAAAEAAAABAAAAAQAAAAEAAAAUc3RzegAAAAAAAAD+AAAAAQAAABRzdGNvAAAAAAAAAAEAAAAkAAAAIHVkdGEAAAAYqXN3cgAMVcRMYXZmNjEuNy4xMDA=",
  mime: "video/quicktime",
  codes: [
    [543 / 1023, 366 / 1023, 634 / 1023],
    [456 / 1023, 659 / 1023, 388 / 1023],
    [499 / 1023, 512 / 1023, 512 / 1023],
    [830 / 1023, 512 / 1023, 512 / 1023],
  ],
};

const SAMPLE_AT: readonly (readonly [number, number])[] = [
  [16, 16],
  [48, 16],
  [16, 48],
  [48, 48],
];

/** The color space a route's decoder is asked to tag frames with: sRGB at
 * the file's own range, through Rec.709 for the WebCodecs decoders, whose
 * rewritten SPS carries the same tags. The WASM ProRes route asks for
 * BT.601: Chrome's 4:2:2 10-bit draw mixes the coefficients under a Rec.709
 * tag and follows a BT.601 tag exactly, and WebKit follows either, so the
 * one tag both draw exactly is the one asked for. */
export function decodeOverrideFor(route: DecodeRoute, fullRange: boolean): VideoColorSpaceInit {
  return { primaries: "bt709", transfer: "iec61966-2-1", matrix: route === "prores" ? "smpte170m" : "bt709", fullRange };
}

const MATRICES: readonly CodeFormat["matrix"][] = ["bt709", "bt601", "bt2020nc"];
/** The nearest candidate wins when its worst channel is within this many
 * 8-bit levels: chroma upsampling and rounding. The candidates sit far
 * further apart from each other, and a converted frame from all of them. */
const TOLERANCE = 6;

const results = new Map<string, Promise<DecodePathResult>>();
const settled = new Map<string, DecodePathResult>();
const keyOf = (route: DecodeRoute, fullRange: boolean) => `${route}|${fullRange ? "full" : "limited"}`;

/** What the route draws for a track read with the override at `fullRange`;
 * measured once per session, on a failure counted as converted. */
export function decodePath(route: DecodeRoute, fullRange: boolean): Promise<DecodePathResult> {
  const key = keyOf(route, fullRange);
  let p = results.get(key);
  if (!p) {
    p = (route === "headless" ? Promise.resolve<DecodePathResult>({ kind: "source" }) : measure(route, fullRange)).catch(
      (): DecodePathResult => ({ kind: "converted" })
    );
    p.then((r) => settled.set(key, r));
    results.set(key, p);
  }
  return p;
}

/** The measured result, or undefined while the measurement runs. Asking
 * starts it. */
export function decodePathNow(route: DecodeRoute, fullRange: boolean): DecodePathResult | undefined {
  void decodePath(route, fullRange);
  return settled.get(keyOf(route, fullRange));
}

/** Forget every measurement (tests). */
export function clearDecodePaths(): void {
  results.clear();
  settled.clear();
}

async function measure(route: "webcodecs" | "prores", fullRange: boolean): Promise<DecodePathResult> {
  const fixture = route === "prores" ? PRORES_HLG : H264_HLG;
  if (route === "prores") await ensureProresDecoder();
  const bytes = Uint8Array.from(atob(fixture.base64), (c) => c.charCodeAt(0));
  const input = openMedia(new Blob([bytes], { type: fixture.mime }));
  try {
    const track = await videoTrackOf(input);
    if (!track) return { kind: "converted" };
    // The fixture is coded limited range; read under a full-range override
    // it shows whether this decoder honors the flag.
    const sink = frameSink(track, undefined, { colorSpace: decodeOverrideFor(route, fullRange) });
    const frame = await sink.getCanvas(0);
    if (!frame) return { kind: "converted" };
    const ctx = frame.canvas.getContext("2d") as CanvasRenderingContext2D | null;
    if (!ctx) return { kind: "converted" };
    const drawn = SAMPLE_AT.map(([x, y]) => Array.from(ctx.getImageData(x, y, 1, 1).data.subarray(0, 3)));
    return classify(drawn, fixture.codes);
  } finally {
    input.dispose();
  }
}

/** The matrix and range whose expected tiles sit nearest the drawn ones. */
export function classify(
  drawn: readonly (readonly number[])[],
  codes: Fixture["codes"]
): DecodePathResult {
  let best: DecodePathResult = { kind: "converted" };
  let bestErr = Infinity;
  for (const matrix of MATRICES) {
    for (const fullRange of [false, true]) {
      let err = 0;
      codes.forEach(([y, cb, cr], i) => {
        const want = decodeYcc({ matrix, fullRange }, y, cb, cr);
        for (let c = 0; c < 3; c++) err = Math.max(err, Math.abs(drawn[i][c] - Math.round(Math.min(1, Math.max(0, want[c])) * 255)));
      });
      if (err < bestErr) {
        bestErr = err;
        best = { kind: "code", drawnMatrix: matrix, drawnFullRange: fullRange };
      }
    }
  }
  return bestErr <= TOLERANCE ? best : { kind: "converted" };
}
