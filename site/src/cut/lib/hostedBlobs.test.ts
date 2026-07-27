import { beforeEach, describe, expect, test } from "bun:test";

import { offloadHostedMedia } from "./hostedBlobs";

// One picture, large enough to be worth storing.
const bigImage = btoa("x".repeat(200_000));
const otherImage = btoa("y".repeat(200_000));
const tinyImage = btoa("z".repeat(1_000));

type Call = { url: string; body?: unknown; clientId?: string | null };
let calls: Call[] = [];
let claim: (n: number) => unknown;

function stubFetch() {
  calls = [];
  globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
    const href = String(url);
    if (href === "/api/inference/uploads") {
      const body = JSON.parse(String(init?.body)) as { blobs: unknown[] };
      calls.push({
        url: href,
        body,
        clientId: new Headers(init?.headers).get("x-donkey-client-id"),
      });
      return new Response(JSON.stringify({ blobs: body.blobs.map((_, i) => claim(i)) }), {
        status: 200,
      });
    }
    calls.push({ url: href });
    return new Response(null, { status: 200 });
  }) as unknown as typeof fetch;
}

describe("offloadHostedMedia", () => {
  beforeEach(() => {
    claim = (n) => ({ blobRef: `cut/inference/u1/hash${n}.png`, putUrl: `https://r2/put/${n}` });
    stubFetch();
  });

  test("a picture leaves the body and travels as a reference", async () => {
    const out = (await offloadHostedMedia({
      kind: "image",
      prompt: "hi",
      inputs: { images: [{ data: bigImage, mimeType: "image/png" }] },
    }, "donkey-cut")) as { inputs: { images: Record<string, unknown>[] } };

    const part = out.inputs.images[0];
    expect(part.data).toBeUndefined();
    expect(part.blobRef).toBe("cut/inference/u1/hash0.png");
    // The field the bytes came out of, so the server puts them back in it.
    expect(part.blobField).toBe("data");
    expect(part.mimeType).toBe("image/png");
    expect(calls.map((c) => c.url)).toEqual(["/api/inference/uploads", "https://r2/put/0"]);
    // The claim is an inference call like any other, and the routes require it.
    expect(calls[0].clientId).toBe("donkey-cut");
  });

  test("content parts keep their own payload field", async () => {
    const out = (await offloadHostedMedia({
      input: [{ type: "input_image", dataBase64: bigImage, mimeType: "image/jpeg" }],
    }, "donkey-cut")) as { input: Record<string, unknown>[] };

    expect(out.input[0].dataBase64).toBeUndefined();
    expect(out.input[0].blobField).toBe("dataBase64");
  });

  test("the same picture in many requests uploads once", async () => {
    const body = { inputs: { images: [{ data: otherImage, mimeType: "image/png" }] } };
    await offloadHostedMedia(body, "donkey-cut");
    const before = calls.length;
    const out = (await offloadHostedMedia(body, "donkey-cut")) as {
      inputs: { images: Record<string, unknown>[] };
    };
    // Second pass: no claim, no PUT, and still a reference.
    expect(calls.length).toBe(before);
    expect(out.inputs.images[0].blobRef).toBe("cut/inference/u1/hash0.png");
  });

  test("a payload storage refuses stays in the body", async () => {
    claim = () => ({ skipped: "unsupported" });
    const out = (await offloadHostedMedia({
      inputs: { images: [{ data: btoa("q".repeat(200_000)), mimeType: "image/avif" }] },
    }, "donkey-cut")) as { inputs: { images: Record<string, unknown>[] } };

    expect(out.inputs.images[0].blobRef).toBeUndefined();
    expect(typeof out.inputs.images[0].data).toBe("string");
  });

  test("storage being down never fails the request", async () => {
    globalThis.fetch = (async () => new Response(null, { status: 503 })) as unknown as typeof fetch;
    const out = (await offloadHostedMedia({
      inputs: { images: [{ data: btoa("w".repeat(200_000)), mimeType: "image/png" }] },
    }, "donkey-cut")) as { inputs: { images: Record<string, unknown>[] } };

    expect(typeof out.inputs.images[0].data).toBe("string");
  });

  test("small payloads and plain fields are left alone", async () => {
    const body = {
      prompt: "a long prompt that is not media at all",
      inputs: { images: [{ data: tinyImage, mimeType: "image/png" }] },
      parameters: { data: "not base64, just a string" },
    };
    expect(await offloadHostedMedia(body, "donkey-cut")).toBe(body);
    expect(calls.length).toBe(0);
  });
});
