// The hosted matte (video background-removal) model ids, hardcoded like the
// Gemini registries: configuration is code, and pricing keys off these exact
// strings.

// The segmenter: one call takes a clip plus a text description, click
// prompts, or both together (points refine what the words detected), and
// returns the mask video (apply_mask: false renders the white-on-black mask;
// the sibling video-rle endpoint returns RLE JSON with no video output).
export const falMatteModels = {
  segmenter: "fal-ai/sam-3/video",
} as const;

export type FalMatteModel = (typeof falMatteModels)[keyof typeof falMatteModels];
