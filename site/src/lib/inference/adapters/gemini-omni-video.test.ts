import { describe, expect, test } from "bun:test";
import { createGeminiOmniVideoAssetProvider } from "./gemini-omni-video";
import type { AssetGenerationRequest } from "@/lib/inference/providers";

// The unit math the credit preflight holds a render to: seconds of
// 360p-equivalent output from the requested length and resolution.
const provider = createGeminiOmniVideoAssetProvider(
  {
    GOOGLE_APPLICATION_CREDENTIALS_JSON: JSON.stringify({
      project_id: "p",
      client_email: "svc@example.invalid",
      private_key: "-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----\n",
    }),
  },
  () => ({ interactions: {} as never }),
);

const request = (parameters: Record<string, unknown>): AssetGenerationRequest =>
  ({ kind: "video", prompt: "a clip", parameters }) as AssetGenerationRequest;

// The route hands the counter a resolver that reads seed frames and reference
// pictures out of storage. Counting seconds never needs them, so a call to it
// is a bug: it would pull whole objects before the balance clears.
let resolverCalls = 0;
const resolveInputs = async (): Promise<AssetGenerationRequest> => {
  resolverCalls++;
  return request({});
};
const countFor = (parameters: Record<string, unknown>) =>
  provider.assetGenerationCountFor!(request(parameters), resolveInputs);

describe("Omni generation units", () => {
  test("scales with length and resolution", async () => {
    expect(await countFor({ durationSeconds: 10, resolution: "720p" })).toBe(30);
    expect(await countFor({ durationSeconds: 4, resolution: "360p" })).toBe(4);
    expect(await countFor({ durationSeconds: 10, resolution: "4k" })).toBe(90);
    expect(await countFor({ durationSeconds: 6, resolution: "1080p" })).toBe(27);
  });

  test("an unset length bills the model's ceiling at the default size", async () => {
    expect(await countFor({})).toBe(30);
  });

  test("refuses a size or length the model does not render", async () => {
    const failure = async (parameters: Record<string, unknown>) => {
      try {
        await countFor(parameters);
      } catch (error) {
        return String(error);
      }
      return "";
    };
    expect((await failure({ resolution: "8k" })).includes("resolution")).toBe(true);
    expect((await failure({ resolution: 1080 })).includes("resolution")).toBe(true);
    expect((await failure({ resolution: "" })).includes("resolution")).toBe(true);
    expect((await failure({ durationSeconds: 2 })).includes("length")).toBe(true);
    expect((await failure({ durationSeconds: 5.5 })).includes("length")).toBe(true);
  });

  test("counts without reading the request's media", async () => {
    resolverCalls = 0;
    await countFor({ durationSeconds: 8, resolution: "720p" });
    expect(resolverCalls).toBe(0);
  });
});
