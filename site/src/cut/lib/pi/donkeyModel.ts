import type { Model } from "@earendil-works/pi-ai";

// The chat loop's models as pi Model objects. The custom api id routes every
// call through donkeyStream — pi's own providers never see these — so the only
// fields that matter downstream are `id` (the hosted route's model string) and
// the metadata pi reads for bookkeeping.
export type DonkeyApi = "donkey-responses";

const ZERO_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

export function donkeyModel(id: string): Model<DonkeyApi> {
  return {
    id,
    name: id,
    api: "donkey-responses",
    provider: "donkey",
    baseUrl: "/api/inference/responses",
    reasoning: false,
    input: ["text", "image"],
    cost: ZERO_COST,
    contextWindow: 1_000_000,
    maxTokens: 65_536,
  };
}
