import { expect, test } from "bun:test";
import { stubModule } from "@/lib/testing/stubModule";
import type { ExportDoc } from "@/cut/lib/renderSnapshot";

// The export spec's color: what each clip's code values mean, and the
// library LUTs its grades name staged beside the pictures, once per file.

const CUBE = 'TITLE "warm"\nLUT_3D_SIZE 2\n0 0 0\n1 0 0\n0 1 0\n1 1 0\n0 0 1\n1 0 1\n0 1 1\n1 1 1\n';

await stubModule<typeof import("./linkedLibrary/luts")>("./linkedLibrary/luts", import.meta.url, {
  loadLibraryLutFile: async (id) => {
    if (id === "lut:abc123") return { fileName: "Warm Film.cube", bytes: new TextEncoder().encode(CUBE) };
    throw new Error(`The LUT "Broken" could not be read.`);
  },
});

const { buildExportPayload, originalSettings } = await import("./exportClient");
const { registerBlobFile } = await import("./backend/browser/registry");
const { movieHeader } = await import("./fixtures/movieHeader");

// Footage imported before its color was read: the spec builder reads the
// header itself. This one is an HLG phone clip.
const plainUrl = registerBlobFile(
  "/api/cut/projects/project/media/plain.mp4",
  new File([movieHeader({ primaries: 9, transfer: 18, matrix: 9 }) as BlobPart], "plain.mp4")
);

const doc: ExportDoc = {
  aspect: "16:9",
  assets: [
    { id: "log", fileName: "log.mov", name: "Log", type: "video", duration: 10, width: 1920, height: 1080, url: "",
      color: { matrix: "bt2020nc", fullRange: false, bitDepth: 10, detected: "apple-log" } },
    { id: "sd", fileName: "sd.mp4", name: "SD", type: "video", duration: 10, width: 640, height: 480, url: "",
      color: { matrix: "bt601", fullRange: true, bitDepth: 8, detected: "rec709" }, colorProfile: "srgb" },
    { id: "plain", fileName: "plain.mp4", name: "Plain", type: "video", duration: 10, width: 1920, height: 1080, url: plainUrl },
    { id: "still", fileName: "still.png", name: "Still", type: "image", duration: 5, width: 800, height: 600, url: "" },
  ],
  clips: [
    { id: "c1", assetId: "log", track: 0, start: 0, in: 0, out: 2, muted: false, grade: { lut: { id: "lut:abc123" }, exposure: 5 } },
    { id: "c2", assetId: "sd", track: 0, start: 2, in: 0, out: 2, muted: false },
    { id: "c3", assetId: "plain", track: 0, start: 4, in: 0, out: 2, muted: false, grade: { lut: { id: "lut:abc123", amount: 0.5 } } },
    { id: "o1", assetId: "still", track: 1, start: 0, in: 0, out: 2, muted: true, grade: { lut: { id: "lut:abc123" } } },
  ],
  audioClips: [],
  overlays: [],
  subtitles: { cues: [], showOnVideo: false, showOnTimeline: false },
};

test("every clip carries its color, and a library LUT travels once by content key", async () => {
  const settings = originalSettings(doc.aspect, doc.clips, doc.assets, doc);
  const payload = await buildExportPayload("project", doc, settings, "export");
  const spec = payload.spec as {
    colorSpace: string;
    lutSize: number;
    lutSizeWide: number;
    clips: { file: string; color?: Record<string, unknown> }[];
    overlayVideos: { file: string; color?: Record<string, unknown> }[];
  };
  expect(spec).toMatchObject({ colorSpace: "sdr", lutSize: 33, lutSizeWide: 65 });
  const byFile = new Map(spec.clips.map((c) => [c.file, c.color]));
  expect(byFile.get("log.mov")).toEqual({ profile: "apple-log", matrix: "bt2020nc", fullRange: false, lutFile: "lut_abc123.cube" });
  expect(byFile.get("sd.mp4")).toEqual({ profile: "srgb", matrix: "bt601", fullRange: true });
  expect(byFile.get("plain.mp4")).toEqual({ profile: "hlg", matrix: "bt2020nc", fullRange: false, lutFile: "lut_abc123.cube" });
  expect(spec.overlayVideos[0].color).toEqual({ profile: "srgb", matrix: "bt709", fullRange: true, lutFile: "lut_abc123.cube" });
  const luts = payload.pngs.filter((p) => p.name.endsWith(".cube"));
  expect(luts.map((p) => p.name)).toEqual(["lut_abc123.cube"]);
  expect(await luts[0].blob.text()).toBe(CUBE);
  // A converted source never rides the packet copy.
  expect("sourceSegments" in spec && (spec as { sourceSegments?: unknown }).sourceSegments).toBeFalsy();
});

test("a LUT that cannot be read fails the export, naming it", async () => {
  const broken: ExportDoc = {
    ...doc,
    clips: [{ id: "c1", assetId: "plain", track: 0, start: 0, in: 0, out: 2, muted: false, grade: { lut: { id: "lut:gone" } } }],
  };
  const settings = originalSettings(broken.aspect, broken.clips, broken.assets, broken);
  await expect(buildExportPayload("project", broken, settings, "export")).rejects.toThrow(/The LUT "Broken" could not be read/);
});

test("a source profile set before the header was read still exports the file's own code values", async () => {
  // An HLG clip imported before its color was read, set to Apple Log by hand:
  // the override names the profile, and the header read still supplies the
  // matrix and range.
  const overridden: ExportDoc = {
    ...doc,
    assets: doc.assets.map((a) => (a.id === "plain" ? { ...a, colorProfile: "apple-log" as const } : a)),
    clips: [{ id: "c1", assetId: "plain", track: 0, start: 0, in: 0, out: 2, muted: false }],
  };
  const settings = originalSettings(overridden.aspect, overridden.clips, overridden.assets, overridden);
  const payload = await buildExportPayload("project", overridden, settings, "export");
  const spec = payload.spec as { clips: { file: string; color?: Record<string, unknown> }[] };
  expect(spec.clips[0].color).toEqual({ profile: "apple-log", matrix: "bt2020nc", fullRange: false });
});
