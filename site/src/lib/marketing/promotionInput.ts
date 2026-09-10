import { audienceSchema, type Audience } from "@donkeycut/abexp";
import { z } from "zod";
import { CLAIM_URL_PLACEHOLDER, promotionOfferSchema, type PromotionOffer } from "@/lib/marketing/promotionOfferInput";

// The shape of a promotion as su writes it and the routes validate it.
// Client-safe: zod only, so the dialog parses the same schema the server does.

export const PROMOTION_SENDERS = ["bulk", "personal"] as const;
export type PromotionSender = (typeof PROMOTION_SENDERS)[number];

export const PROMOTION_STATUSES = ["draft", "sending", "paused", "sent"] as const;

export type PromotionStatus = (typeof PROMOTION_STATUSES)[number];

export const promotionInputSchema = z
  .object({
    name: z.string().trim().min(1).max(80),
    subject: z.string().trim().min(1).max(200),
    body: z.string().trim().min(1).max(10_000),
    ctaLabel: z.string().trim().min(1).max(80).nullable(),
    ctaUrl: z
      .union([
        z.literal(CLAIM_URL_PLACEHOLDER),
        z.url({ protocol: /^https?$/, error: "Use an HTTP or HTTPS link." }).max(2000),
      ])
      .nullable(),
    creditOffer: promotionOfferSchema.nullable().default(null),
    sender: z.enum(PROMOTION_SENDERS),
    audience: audienceSchema,
    // Earlier promotions whose recipients are left out.
    excludePromotionIds: z.array(z.string().min(1)).max(100),
  })
  .strict()
  .refine((d) => (d.creditOffer !== null) === (d.ctaUrl === CLAIM_URL_PLACEHOLDER), {
    message: "A credit offer needs a claim button. Set its link to {{claimUrl}}.",
    path: ["ctaUrl"],
  })
  .refine((d) => (d.ctaLabel === null) === (d.ctaUrl === null), {
    message: "A button needs both a label and a link.",
    path: ["ctaLabel"],
  });

export type PromotionInput = z.output<typeof promotionInputSchema>;

export type PromotionSummary = {
  creditOffer: PromotionOffer | null;
  id: string;
  name: string;
  subject: string;
  body: string;
  ctaLabel: string | null;
  ctaUrl: string | null;
  sender: PromotionSender;
  audience: Audience;
  excludePromotionIds: string[];
  status: PromotionStatus;
  startedAt: string | null;
  finishedAt: string | null;
  createdAt: string;
  updatedAt: string;
  // Recipients queued, sent, failed, and what came of it: buttons followed,
  // credit offers claimed.
  counts: { recipients: number; sent: number; failed: number; clicked: number; claimed: number };
};

// What a segment resolves to before anything is sent.
export type SegmentCount = {
  recipients: number;
  unsubscribed: number;
  alreadyReceived: number;
  outsideAudience: number;
};
