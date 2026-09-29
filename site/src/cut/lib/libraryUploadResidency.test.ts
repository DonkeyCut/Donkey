import { afterEach, describe, expect, spyOn, test } from "bun:test";
import * as residency from "./residency";
import * as media from "./media";
import * as preparation from "./cloudLibraryUpload";
import { uploadToLibrary, type LibraryAsset } from "./library";
import type { CutBackend } from "./backend";

const restores: (() => void)[] = [];
afterEach(() => { for (const restore of restores.splice(0)) restore(); });
const file = () => new File(["phone video"], "phone.mov", { type: "video/quicktime" });
const asset: LibraryAsset = { id: "asset", fileName: "phone.mp4", name: "phone.mov", type: "video", duration: 1, addedAt: 0, residency: "cloud" };
const meta = { type: "video" as const, duration: 1, width: 64, height: 64 };
function backend(kind: CutBackend["kind"], respond = () => Response.json(asset)) {
  const fetches: { path: string; init?: RequestInit }[] = [];
  const driver = { kind, fetch: async (path: string, init?: RequestInit) => {
    fetches.push({ path, init });
    return respond();
  } } as CutBackend;
  const seam = spyOn(residency, "backendFor").mockReturnValue(driver);
  restores.push(() => seam.mockRestore());
  return fetches;
}

describe("library import residencies", () => {
  test("cloud hands unreadable footage to preparation", async () => {
    backend("cloud");
    const probe = spyOn(media, "probeFileMeta").mockImplementation(async () => { throw new Error("Decoder unavailable"); });
    const prepare = spyOn(preparation, "uploadCloudLibraryMedia").mockResolvedValue(asset);
    restores.push(() => probe.mockRestore(), () => prepare.mockRestore());
    const source = file();
    expect(await uploadToLibrary(source, "cloud")).toEqual(asset);
    expect(prepare.mock.calls[0]?.[0]).toBe(source);
  });

  test("readable cloud media keeps the direct upload path", async () => {
    const fetches = backend("cloud");
    const probe = spyOn(media, "probeFileMeta").mockResolvedValue(meta);
    const upload = spyOn(media, "presignedUpload").mockResolvedValue("stored");
    const prepare = spyOn(preparation, "uploadCloudLibraryMedia");
    restores.push(() => probe.mockRestore(), () => upload.mockRestore(), () => prepare.mockRestore());
    await uploadToLibrary(file(), "cloud");
    expect(fetches[0]?.path).toBe("/api/cut/library/complete");
    expect(prepare).not.toHaveBeenCalled();
  });

  test("browser-local footage uses prepared bytes and lands in browser storage", async () => {
    const fetches = backend("browser");
    const probe = spyOn(media, "probeFileMeta").mockImplementation(async (source) => {
      if (source.name === "phone.mov") throw new Error("Decoder unavailable");
      return meta;
    });
    const prepared = new File(["playable"], "phone.mp4", { type: "video/mp4" });
    const prepare = spyOn(preparation, "withCloudPreparedMedia").mockImplementation(async (_file, adopt) => adopt(prepared));
    restores.push(() => probe.mockRestore(), () => prepare.mockRestore());
    expect((await uploadToLibrary(file(), "browser")).residency).toBe("browser");
    const form = fetches[0]?.init?.body as FormData;
    expect((form.get("file") as File).name).toBe("phone.mp4");
    expect(form.get("name")).toBe("phone.mov");
    expect(prepare.mock.calls.length).toBe(1);
  });

  test("engine storage receives the original and a preparation request", async () => {
    const fetches = backend("local");
    const probe = spyOn(media, "probeFileMeta").mockImplementation(async () => { throw new Error("Decoder unavailable"); });
    restores.push(() => probe.mockRestore());
    expect((await uploadToLibrary(file(), "local")).residency).toBe("local");
    const form = fetches[0]?.init?.body as FormData;
    expect((form.get("file") as File).name).toBe("phone.mov");
    expect(form.get("prepare")).toBe("true");
  });

  test("engine preparation failure borrows the worker and keeps the chosen storage", async () => {
    let calls = 0;
    const fetches = backend("local", () => ++calls === 1
      ? Response.json({ error: "Decoder unavailable" }, { status: 500 }) : Response.json(asset));
    const probe = spyOn(media, "probeFileMeta").mockImplementation(async (source) => {
      if (source.name === "phone.mov") throw new Error("Decoder unavailable");
      return meta;
    });
    const prepared = new File(["playable"], "phone.mp4", { type: "video/mp4" });
    const prepare = spyOn(preparation, "withCloudPreparedMedia").mockImplementation(async (_file, adopt) => adopt(prepared));
    restores.push(() => probe.mockRestore(), () => prepare.mockRestore());
    expect((await uploadToLibrary(file(), "local")).residency).toBe("local");
    expect(prepare.mock.calls.length).toBe(1);
    const form = fetches[1]?.init?.body as FormData;
    expect((form.get("file") as File).name).toBe("phone.mp4");
    expect(form.get("prepare")).toBeNull();
  });
});
