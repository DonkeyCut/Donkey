import { z } from "zod";

export const promotionOfferSchema = z.object({
  dollars: z.number().int().min(1).max(10000),
  claimWindowDays: z.number().int().min(1).max(365),
  expiresAfterDays: z.number().int().min(1).max(3650),
}).strict();

export type PromotionOffer = z.infer<typeof promotionOfferSchema>;
export const CLAIM_URL_PLACEHOLDER = "{{claimUrl}}";
export const SAMPLE_CLAIM_URL = "https://example.com/preview-credit-offer";

export function promotionOfferOf(value: unknown): PromotionOffer | null {
  return value == null ? null : promotionOfferSchema.parse(value);
}
