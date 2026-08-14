// Central registry of Gemini model IDs used by the inference gateway.
//
// Model selection lives in code (see docs/guides/backend-apis.md), so this is
// the single source of truth for which Gemini models we run and what each one
// is for. Adapters and schemas should import these constants instead of
// hardcoding version strings, so bumping a model is a one-line change here.

// Canonical, dated-or-versioned model IDs. Add a new constant when adopting a
// new model; do not inline raw version strings at call sites.
export const geminiModels = {
  flash: "gemini-3.5-flash",
  flashLite: "gemini-3.1-flash-lite",
  // Generative image editing/generation ("nano banana"). Bump here when adopting a
  // newer image model.
  flashImage: "gemini-2.5-flash-image",
  // "Nano banana pro": higher-fidelity image editing/generation that takes a real
  // aspectRatio + imageSize (1K/2K/4K) via imageConfig. GA since 2026-05-28 (the
  // -preview id was shut down 2026-06-25); served only on Vertex's global
  // endpoint, which our client already targets.
  proImage: "gemini-3-pro-image",
} as const;

export type GeminiModel = (typeof geminiModels)[keyof typeof geminiModels];

// Unified video generation (Gemini Omni Flash): one Interactions API call takes
// text plus optional seed/reference images and renders up to ~10s of 720p video
// with audio. The clip length is the model's call — there is no duration knob —
// and image output is not enabled for this model. Bump here when adopting a
// newer Omni.
export const geminiOmniModels = {
  flashVideo: "gemini-omni-flash-preview",
} as const;

export type GeminiOmniModel = (typeof geminiOmniModels)[keyof typeof geminiOmniModels];

// The most reference images an Omni render accepts; the adapter clamps and the
// client registry (videoModels.ts) reads the same number.
export const geminiOmniMaxReferenceImages = 3;

// Generative speech (Gemini TTS): text in, spoken audio out, with prompt-driven
// style direction and inline audio tags. Bump here when adopting a newer TTS model.
export const geminiTtsModels = {
  flash: "gemini-3.1-flash-tts-preview",
} as const;

export type GeminiTtsModel = (typeof geminiTtsModels)[keyof typeof geminiTtsModels];

// Generative music (Gemini/Lyria) over the Interactions API: a text prompt in,
// an instrumental clip out — the background bed for a cut. `clip` renders a
// fixed ~30s clip; `pro` a full-length (~2min) track. These are the legacy
// Lyria interaction models, which run on our Vertex path (unlike Lyria RealTime,
// the live WebSocket API, which Vertex rejects). Bump here to adopt a newer Lyria.
export const geminiMusicModels = {
  clip: "lyria-3-clip-preview",
  pro: "lyria-3-pro-preview",
} as const;

export type GeminiMusicModel = (typeof geminiMusicModels)[keyof typeof geminiMusicModels];

// Semantic roles map a job to the model we run for it. Prefer referencing a
// role over a bare constant so intent stays explicit at the call site.
export const geminiModelRoles = {
  // General chat and non-decision Responses calls — the latest full flash.
  chat: geminiModels.flash,
  // Chat turns the gate judges simple — one self-contained ask runs on the
  // light chat model; complex turns stay on `chat`.
  chatSimple: geminiModels.flashLite,
  // Fast structured task-intent and follow-up decisions.
  fastDecision: geminiModels.flashLite,
  // Generative image editing and generation.
  imageGeneration: geminiModels.proImage,
  // Production review: the director judging rendered takes and minted frames
  // against the plan, sheets, and benchmarks. Runs the strongest multimodal
  // judge we serve — bump here to upgrade every review gate at once.
  review: geminiModels.flash,
} as const;
