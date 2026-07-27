import { describe, expect, test } from "bun:test";

import { resolveInferenceBlobs, type BlobReader } from "./blobs";

const stored = new Map<string, { bytes: Buffer; mime: string }>([
  ["cut/inference/u1/abc.png", { bytes: Buffer.from("picture bytes"), mime: "image/png" }],
]);
const read: BlobReader = async (key) => stored.get(key) ?? null;

const b64 = Buffer.from("picture bytes").toString("base64");

async function failure(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
    return "";
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
}

describe("resolveInferenceBlobs", () => {
  test("a reference becomes bytes in the field it names", async () => {
    const out = (await resolveInferenceBlobs(
      {
        prompt: "hi",
        inputs: { images: [{ blobRef: "cut/inference/u1/abc.png", blobField: "data" }] },
      },
      "u1",
      read
    )) as { inputs: { images: Record<string, unknown>[] } };

    const part = out.inputs.images[0];
    expect(part.data).toBe(b64);
    expect(part.mimeType).toBe("image/png");
    expect(part.blobRef).toBeUndefined();
    expect(part.blobField).toBeUndefined();
  });

  test("a content part's payload field is honored", async () => {
    const out = (await resolveInferenceBlobs(
      [{ type: "input_image", blobRef: "cut/inference/u1/abc.png", blobField: "dataBase64" }],
      "u1",
      read
    )) as Record<string, unknown>[];

    expect(out[0].dataBase64).toBe(b64);
    expect(out[0].type).toBe("input_image");
  });

  test("another account's object is refused", async () => {
    const message = await failure(
      resolveInferenceBlobs(
        { inputs: { images: [{ blobRef: "cut/inference/u2/abc.png", blobField: "data" }] } },
        "u1",
        read
      )
    );
    expect(message.includes("does not belong")).toBe(true);
  });

  test("a swept object reads as a plain retry, not a broken request", async () => {
    const message = await failure(
      resolveInferenceBlobs(
        { inputs: { images: [{ blobRef: "cut/inference/u1/gone.png", blobField: "data" }] } },
        "u1",
        read
      )
    );
    expect(message.includes("no longer in storage")).toBe(true);
  });

  test("a body carrying no references is returned as it came", async () => {
    const body = { prompt: "hi", inputs: { images: [{ data: "inline", mimeType: "image/png" }] } };
    expect(await resolveInferenceBlobs(body, "u1", read)).toEqual(body);
  });
});
