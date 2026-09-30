// The names a promotion row holds.

export const PROMOTION_SENDERS = ["bulk", "personal"] as const;
export type PromotionSender = (typeof PROMOTION_SENDERS)[number];

// What a segment resolves to before anything is sent.
export type SegmentCount = {
  recipients: number;
  unsubscribed: number;
  alreadyReceived: number;
  outsideAudience: number;
};
