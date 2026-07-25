import { z } from "zod";

import { toJsonObject } from "@/lib/inference/json";

const metadataSchema = z.record(z.string().min(1).max(64), z.string().max(512));
const jsonObjectSchema = z.record(z.string(), z.unknown());

export const inferenceModalitySchema = z.enum([
  "text",
  "image",
  "video",
  "audio",
  "music",
  "speech",
]);

export const assetGenerationKindSchema = z.enum(["image", "video", "music", "speech"]);

export const modelsQuerySchema = z.object({
  output_modalities: z.string().optional(),
});

// Model is optional, exactly like `responseCreateRequestSchema`: a model-neutral caller (the notch reply
// stream, the request-understanding stream) omits it and the provider resolves its default. Keeping the two
// schemas symmetric is what lets the same caller stay provider-neutral whether it streams or not.
export const chatCompletionRequestSchema = z
  .object({
    messages: z.array(jsonObjectSchema).min(1),
    model: z.string().min(1).max(256).optional(),
    models: z.array(z.string().min(1).max(256)).min(1).optional(),
    stream: z.boolean().optional().default(false),
    modalities: z.array(z.enum(["text", "image", "audio"])).optional(),
    provider: jsonObjectSchema.optional(),
    metadata: metadataSchema.optional(),
  })
  .passthrough();

export const responsesProviderSelectionSchema = z.enum(["openai", "gemini"]);

export const responseCreateRequestSchema = z
  .object({
    donkeyProvider: responsesProviderSelectionSchema.optional(),
    input: z.union([
      z.string().min(1).max(200_000),
      z.array(jsonObjectSchema).min(1),
    ]),
    model: z.string().min(1).max(256).optional(),
    store: z.boolean().optional().default(false),
    stream: z.boolean().optional().default(false),
    tools: z.array(jsonObjectSchema).optional(),
    metadata: metadataSchema.optional(),
  })
  .passthrough()
  .transform((value) => {
    const { donkeyProvider, ...body } = value;
    // `stream` selects the route's SSE branch; the provider body always says
    // stream:false because the adapter picks its own streaming API call.
    return {
      donkeyProvider,
      stream: value.stream,
      body: toJsonObject({
        ...body,
        store: body.store ?? false,
        stream: false,
      }),
    };
  });

export const assetGenerationRequestSchema = z.object({
  generationId: z.string().min(1).max(128).optional(),
  kind: assetGenerationKindSchema,
  provider: z.string().min(1).max(100).optional(),
  // Optional so a fully model-neutral caller (e.g. the image.* tools) can let the
  // selected provider pick its default model. Providers that need an explicit model
  // resolve their own default.
  model: z.string().min(1).max(256).optional(),
  prompt: z.string().min(1).max(20_000),
  inputs: jsonObjectSchema.optional(),
  parameters: jsonObjectSchema.optional(),
  metadata: metadataSchema.optional(),
});

const nullableProviderStringSchema = z
  .string()
  .min(1)
  .max(2048)
  .nullable()
  .optional()
  .transform((value) => value ?? null);

export const generationOutputRefSchema = z.object({
  id: z.string().min(1).max(128),
  kind: inferenceModalitySchema,
  url: z.string().max(4096).optional(),
  dataBase64: z.string().optional(),
  contentType: z.string().max(256).optional(),
  filename: z.string().max(256).optional(),
  byteCount: z.number().int().nonnegative().optional(),
  metadata: jsonObjectSchema.optional(),
}).transform((value) => ({
  ...value,
  metadata: value.metadata ? toJsonObject(value.metadata) : undefined,
}));

export const storedGenerationForProviderSchema = z.object({
  id: z.string().min(1).max(128),
  kind: assetGenerationKindSchema,
  provider: z.string().min(1).max(100),
  model: z.string().min(1).max(256),
  providerJobId: nullableProviderStringSchema,
  providerGenerationId: nullableProviderStringSchema,
  providerPollingUrl: nullableProviderStringSchema,
  outputs: z.array(generationOutputRefSchema).optional().default([]),
  metadata: jsonObjectSchema.optional().default({}),
}).transform((value) => ({
  ...value,
  metadata: toJsonObject(value.metadata),
}));

export function parseRequestedModalities(value: string | null) {
  if (!value) {
    return ["text"] as const;
  }

  if (value === "all") {
    return ["text", "image", "video", "audio", "music", "speech"] as const;
  }

  return value
    .split(",")
    .map((item) => item.trim())
    .filter((item): item is z.infer<typeof inferenceModalitySchema> => {
      return inferenceModalitySchema.safeParse(item).success;
    });
}
