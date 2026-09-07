import { audienceSchema, type Audience } from "@donkeycut/abexp";
import { z } from "zod";

// The shape of a promotion as su writes it and the routes validate it.
// Client-safe: zod only, so the dialog parses the same schema the server does.

export const PROMOTION_SENDERS = ["bulk", "personal"] as const;
export type PromotionSender = (typeof PROMOTION_SENDERS)[number];

export const PROMOTION_STATUSES = ["draft", "sending", "sent"] as const;

// Sends tried on one recipient before the row is given up.
export const MAX_SEND_ATTEMPTS = 5;
export type PromotionStatus = (typeof PROMOTION_STATUSES)[number];

export const promotionInputSchema = z
  .object({
    name: z.string().trim().min(1).max(80),
    subject: z.string().trim().min(1).max(200),
    body: z.string().trim().min(1).max(10_000),
    ctaLabel: z.string().trim().min(1).max(80).nullable(),
    ctaUrl: z.url().max(2000).nullable(),
    sender: z.enum(PROMOTION_SENDERS),
    audience: audienceSchema,
    // Earlier promotions whose recipients are left out.
    excludePromotionIds: z.array(z.string().min(1)).max(100),
  })
  .strict()
  .refine((d) => (d.ctaLabel === null) === (d.ctaUrl === null), {
    message: "A button needs both a label and a link.",
    path: ["ctaLabel"],
  });

export type PromotionInput = z.output<typeof promotionInputSchema>;

export type PromotionSummary = {
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
  counts: { recipients: number; sent: number; failed: number };
};

// What a segment resolves to before anything is sent.
export type SegmentCount = {
  recipients: number;
  unsubscribed: number;
  alreadyReceived: number;
  outsideAudience: number;
};
