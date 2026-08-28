// The hosted matte model ids, hardcoded like the Gemini registries:
// configuration is code, and pricing keys off these exact strings.

// Two matte jobs, one model each. The segmenter takes a clip plus a text
// description, click prompts, or both together (points refine what the words
// detected) and returns the mask video (apply_mask: false renders the
// white-on-black mask; the sibling video-rle endpoint returns RLE JSON with
// no video output). The removal model takes only the clip — no prompts — and
// masks the foreground subject whole; with output_codec "h264" it returns
// the mask as a grayscale "alpha" video at the segment's own size and rate,
// which is the matte contract's exact shape.
export const falMatteModels = {
  segmenter: "fal-ai/sam-3/video",
  removal: "veed/video-background-removal",
} as const;

export type FalMatteModel = (typeof falMatteModels)[keyof typeof falMatteModels];
