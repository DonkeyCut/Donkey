import type {
  assetGenerationRequestSchema,
  chatCompletionRequestSchema,
  responseCreateRequestSchema,
} from "@/lib/inference/schemas";
import type { z } from "zod";

export type InferenceModality = "text" | "image" | "video" | "audio" | "music" | "speech" | "matte";
export type AssetGenerationKind = "image" | "video" | "music" | "speech" | "matte";
export type GenerationStatus =
  | "pending"
  | "in_progress"
  | "completed"
  | "failed"
  | "cancelled";

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue =
  | JsonPrimitive
  | JsonValue[]
  | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };

export type ChatCompletionRequest = z.infer<typeof chatCompletionRequestSchema>;
export type ResponseCreateRequest = z.infer<typeof responseCreateRequestSchema>;
export type AssetGenerationRequest = z.infer<typeof assetGenerationRequestSchema>;

export type InferenceModel = {
  id: string;
  name: string;
  provider: string;
  inputModalities: InferenceModality[];
  outputModalities: InferenceModality[];
  contextLength: number | null;
  pricing: JsonValue | null;
  metadata: JsonObject;
};

export type GenerationOutputRef = {
  id: string;
  kind: InferenceModality;
  url?: string;
  dataBase64?: string;
  contentType?: string;
  filename?: string;
  byteCount?: number;
  metadata?: JsonObject;
};

export type TextCompletionResult = {
  provider: string;
  model: string;
  body: JsonValue;
  usage?: JsonValue;
  metadata?: JsonObject;
};

export type TextStreamResult = {
  provider: string;
  model: string;
  response: Response;
};

export type ResponseCreateResult = {
  provider: string;
  model: string;
  body: JsonValue;
  usage?: JsonValue;
  metadata?: JsonObject;
};

// A streamed Responses call, as typed events the route serializes to SSE: text
// deltas as they generate, then one terminal event carrying the same body a
// non-streamed call would have returned (so callers run one parsing path) plus
// the usage the route records for billing.
export type ResponseStreamEvent =
  | { type: "output_text_delta"; delta: string }
  | { type: "completed"; body: JsonValue; usage?: JsonValue };

export type ResponseStreamResult = {
  provider: string;
  model: string;
  events: AsyncGenerator<ResponseStreamEvent>;
  metadata?: JsonObject;
};

export type AssetGenerationProviderRequest = {
  generationId: string;
  request: AssetGenerationRequest;
  // The billable unit count the route settled through assetGenerationCountFor,
  // for a provider whose charge scales with the input. The provider bills
  // exactly this count, so the preflight and the charge agree by construction.
  generationCount?: number;
};

export type AssetGenerationProviderResult = {
  provider: string;
  model: string;
  status: GenerationStatus;
  providerJobId?: string;
  providerGenerationId?: string;
  providerPollingUrl?: string;
  outputs: GenerationOutputRef[];
  usage?: JsonValue;
  error?: JsonValue;
  metadata?: JsonObject;
};

export type StoredGenerationForProvider = {
  id: string;
  kind: AssetGenerationKind;
  provider: string;
  model: string;
  providerJobId: string | null;
  providerGenerationId: string | null;
  providerPollingUrl: string | null;
  outputs: GenerationOutputRef[];
  metadata: JsonObject;
};

export type InferenceProvider = {
  id: string;
  configured: boolean;
  capabilities: InferenceModality[];
  responseProviderIDs?: string[];
  listModels: (modalities: InferenceModality[]) => Promise<InferenceModel[]>;
  completeText?: (
    request: ChatCompletionRequest,
  ) => Promise<TextCompletionResult>;
  streamCompletion?: (request: ChatCompletionRequest) => Promise<TextStreamResult>;
  createResponse?: (
    request: ResponseCreateRequest,
  ) => Promise<ResponseCreateResult>;
  createResponseStream?: (
    request: ResponseCreateRequest,
  ) => Promise<ResponseStreamResult>;
  canCreateResponse?: (request: ResponseCreateRequest) => boolean;
  // Positively declares that this provider handles audio/video input parts in a Responses request.
  // The router requires it for media requests so media is routed by capability, not by elimination
  // (a provider that omits this is never handed a media request that it would silently drop).
  handlesResponseMedia?: (request: ResponseCreateRequest) => boolean;
  // The model this provider will bill for a request. Asset adapters resolve a default from an
  // omitted model — and music picks its model from the requested length — so a caller's
  // `request.model` is rarely the id that gets charged. The route asks here before the preflight,
  // which is what lets the preflight price the generation. Throws the same way generateAsset would
  // for an unpriced model, only sooner.
  assetModelFor?: (request: AssetGenerationRequest) => string;
  // How many generation units this request will bill. The route calls it
  // before the credit preflight, so the balance check covers the whole charge,
  // and hands the count back through generateAsset's generationCount. Reading
  // the inputs costs whole objects out of storage, so the request arrives
  // unresolved and `resolveInputs` fetches them: a provider counting off the
  // media (the matte segmenter's frame chunks) awaits it, one counting off the
  // parameters alone (the video renderer's seconds) never does, and an empty
  // balance is refused before anything leaves storage.
  assetGenerationCountFor?: (
    request: AssetGenerationRequest,
    resolveInputs: () => Promise<AssetGenerationRequest>,
  ) => Promise<number>;
  generateAsset?: (
    request: AssetGenerationProviderRequest,
  ) => Promise<AssetGenerationProviderResult>;
  refreshAsset?: (
    generation: StoredGenerationForProvider,
  ) => Promise<AssetGenerationProviderResult>;
};

export class InferenceProviderError extends Error {
  public statusCode: number;
  public code: string;
  public details: JsonValue | null;

  public constructor(
    message: string,
    options: {
      statusCode?: number;
      code?: string;
      details?: JsonValue | null;
    } = {},
  ) {
    super(message);
    this.name = "InferenceProviderError";
    this.statusCode = options.statusCode ?? 502;
    this.code = options.code ?? "provider_error";
    this.details = options.details ?? null;
  }
}
