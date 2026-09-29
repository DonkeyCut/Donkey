import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { cloudBackend } from "./backend/cloud";
import * as jobs from "./cloudJob";
import * as media from "./media";
import { uploadCloudLibraryMedia, withCloudPreparedMedia } from "./cloudLibraryUpload";
import type { LibraryAsset } from "./library";
import type { LibraryUploadState } from "./libraryUpload";

const restores: (() => void)[] = [];
afterEach(() => { for (const restore of restores.splice(0)) restore(); });
const asset: LibraryAsset = { id: "import", fileName: "playable.mp4", originalFile: "phone.mov", name: "phone.mov", type: "video", duration: 1, residency: "cloud", addedAt: 0 };
const file = () => new File(["original media"], "phone.mov", { type: "video/quicktime" });
function harness() {
  const upload = spyOn(media, "presignedUpload").mockResolvedValue("cut/user/library/phone.mov");
  const fetch = spyOn(cloudBackend, "fetch").mockImplementation(async () => Response.json({ jobId: "job" }));
  const poll = spyOn(jobs, "pollCloudJob").mockResolvedValue(asset);
  restores.push(() => upload.mockRestore(), () => fetch.mockRestore(), () => poll.mockRestore());
  return { upload, fetch, poll };
}

describe("cloud library preparation", () => {
  test("uploads original bytes and waits for prepared metadata without browser decoding", async () => {
    const h = harness();
    const source = file();
    const state: LibraryUploadState = {};
    expect(await uploadCloudLibraryMedia(source, { state, folderId: "folder" })).toEqual(asset);
    expect(h.upload.mock.calls[0]?.[1]).toBe(source);
    expect(JSON.parse(String(h.fetch.mock.calls[0]?.[1]?.body))).toMatchObject({ key: state.key, folderId: "folder", name: "phone.mov" });
    expect(h.poll.mock.calls.length).toBe(1);
  });

  test("a retry resumes the existing upload after preparation fails", async () => {
    const h = harness();
    let failed = false;
    h.poll.mockImplementation(async () => { if (!failed) { failed = true; throw new Error("Worker interrupted"); } return asset; });
    const state: LibraryUploadState = {};
    const source = file();
    await expect(uploadCloudLibraryMedia(source, { state })).rejects.toThrow("Worker interrupted");
    expect(await uploadCloudLibraryMedia(source, { state })).toEqual(asset);
    expect(h.upload.mock.calls.length).toBe(1);
    expect(h.fetch.mock.calls.length).toBe(2);
  });

  test("a completed upload returns directly on retry", async () => {
    const h = harness();
    h.fetch.mockResolvedValue(Response.json(asset));
    expect(await uploadCloudLibraryMedia(file(), { state: { key: "stored" } })).toEqual(asset);
    expect(h.upload).not.toHaveBeenCalled();
    expect(h.poll).not.toHaveBeenCalled();
  });

  test("browser-local adoption receives the converted bytes and removes staging", async () => {
    const h = harness();
    const responses = [Response.json({ jobId: "job" }), new Response("converted", { headers: { "Content-Type": "video/mp4" } }), Response.json({ ok: true })];
    h.fetch.mockImplementation(async () => responses.shift()!);
    const state: LibraryUploadState = {};
    const adopted = await withCloudPreparedMedia(file(), async (prepared) => {
      expect(prepared.name).toBe("playable.mp4");
      expect(await prepared.text()).toBe("converted");
      return "saved locally";
    }, { state });
    expect(adopted).toBe("saved locally");
    expect(h.fetch.mock.calls.at(-1)).toEqual(["/api/cut/library/import", { method: "DELETE" }]);
    expect(state.key).toBeUndefined();
  });

  test("failed local adoption removes the temporary cloud copy", async () => {
    const h = harness();
    const responses = [Response.json({ jobId: "job" }), new Response("converted"), Response.json({ ok: true })];
    h.fetch.mockImplementation(async () => responses.shift()!);
    await expect(withCloudPreparedMedia(file(), async () => { throw new Error("Local storage full"); })).rejects.toThrow("Local storage full");
    expect(h.fetch.mock.calls.at(-1)?.[1]?.method).toBe("DELETE");
  });

  test("cleanup failure leaves local adoption untouched so retry cannot duplicate it", async () => {
    const h = harness();
    const responses = [Response.json({ jobId: "job" }), new Response("converted"), new Response(null, { status: 500 })];
    h.fetch.mockImplementation(async () => responses.shift()!);
    let adopted = false;
    const state: LibraryUploadState = {};
    await expect(withCloudPreparedMedia(file(), async () => { adopted = true; }, { state })).rejects.toThrow("temporary cloud import");
    expect(adopted).toBe(false);
    expect(state.key).toBe("cut/user/library/phone.mov");
  });
});
