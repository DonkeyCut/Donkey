// Central registry of Gemini model IDs used by the inference gateway.
//
// Model selection lives in code (see docs/guides/backend-apis.md), so this is
// the single source of truth for which Gemini models we run and what each one
// is for. Adapters and schemas should import these constants instead of
// hardcoding version strings, so bumping a model is a one-line change here.

// Canonical, dated-or-versioned model IDs. Add a new constant when adopting a
// new model; do not inline raw version strings at call sites.
export const geminiModels = {
  flash: "gemini-3.8-flash",
  flashLite: "gemini-3.1-flash-lite",
  // Generative image editing/generation ("nano banana 2"). Bump here when
  // adopting a newer image model.
  flashImage: "gemini-3.1-flash-image",
  // "Nano banana pro": higher-fidelity image editing/generation that takes a real
  // aspectRatio + imageSize (1K/2K/4K) via imageConfig. GA since 2026-05-28 (the
  // -preview id was shut down 2026-06-25); served only on Vertex's global
  // endpoint, which our client already targets.
  proImage: "gemini-3-pro-image",
} as const;

export type GeminiModel = (typeof geminiModels)[keyof typeof geminiModels];

// Unified video generation (Gemini Omni 1.1 Flash): one Interactions API call
// takes text plus optional seed/reference images and renders a clip with audio.
// The request names the resolution and may name the length; with no length the
// model picks (up to ~10s). Image output is not enabled for this model. Bump
// here when adopting a newer Omni.
export const geminiOmniModels = {
  flashVideo: "gemini-omni-1.1-flash-preview",
} as const;

export type GeminiOmniModel = (typeof geminiOmniModels)[keyof typeof geminiOmniModels];

// The most reference images an Omni render accepts; the adapter clamps and the
// client registry (videoModels.ts) reads the same number.
export const geminiOmniMaxReferenceImages = 3;

// Output sizes an Omni render can be asked for. 720p is native; 1080p and 4k
// are upscaled by the model. The panel, the chat tool schema, and the adapter
// all read this list.
export const geminiOmniResolutions = ["360p", "720p", "1080p", "4k"] as const;

export type GeminiOmniResolution = (typeof geminiOmniResolutions)[number];

export const geminiOmniDefaultResolution: GeminiOmniResolution = "720p";

// Clip lengths an Omni render can be asked for, in whole seconds. A request
// with no length lets the model pick, which lands at the top of this range.
export const geminiOmniDurationSeconds = { min: 4, max: 10 } as const;

// Output tokens per rendered second of video with audio, by resolution — the
// unit Omni bills in. A render is charged at submit from the length and
// resolution it asked for (provider-pricing.ts), since the async submit
// returns no counts of its own.
export const geminiOmniTokensPerSecond: Record<GeminiOmniResolution, number> = {
  "360p": 1_931,
  "720p": 5_792,
  "1080p": 8_688,
  "4k": 17_376,
};

/** The billing unit for a video render: one second of 360p output. Every other
 * size bills as its multiple of this, so the credit preflight and the charge
 * count the same thing. */
export const geminiOmniUnitTokens = geminiOmniTokensPerSecond["360p"];

// Generative speech (Gemini TTS): text in, spoken audio out, with prompt-driven
// style direction and inline audio tags. Bump here when adopting a newer TTS model.
export const geminiTtsModels = {
  flash: "gemini-3.1-flash-tts-preview",
} as const;

export type GeminiTtsModel = (typeof geminiTtsModels)[keyof typeof geminiTtsModels];

// Speech-to-text (Gemini Transcribe): a recorded audio file in, the transcript
// with per-word timings out, the language detected by the model. Runs through
// generateContent with an audio transcription config; it takes no prompt,
// system instruction, or output schema. Bump here when adopting a newer one.
export const geminiTranscribeModels = {
  file: "gemini-3.5-transcribe-preview",
} as const;

export type GeminiTranscribeModel =
  (typeof geminiTranscribeModels)[keyof typeof geminiTranscribeModels];

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
  // Hosted speech-to-text: the recorded mix in, word-timed cues out.
  transcription: geminiTranscribeModels.file,
} as const;

/** The role names, for a caller that says what it needs and lets the server
 * pick the id. The page and the turn worker ship separately from the site, so
 * an id baked into their bundles outlives a registry bump; a role name never
 * goes stale. */
export type GeminiModelRole = keyof typeof geminiModelRoles;
export const geminiModelRoleNames = Object.fromEntries(
  Object.keys(geminiModelRoles).map((role) => [role, role]),
) as { [K in GeminiModelRole]: K };

/** A role name becomes its registry id; anything else is an id already. */
export function resolveGeminiModel(value: string): string {
  return Object.hasOwn(geminiModelRoles, value)
    ? geminiModelRoles[value as GeminiModelRole]
    : value;
}
