import { ApiError, GoogleGenAI } from "@google/genai";
import type { GoogleGenAIOptions } from "@google/genai";
import { JWT, type JWTInput } from "google-auth-library";

import { isJsonObject, toJsonValue } from "@/lib/inference/json";
import {
  InferenceProviderError,
  type JsonObject,
  type JsonValue,
} from "@/lib/inference/providers";

// Shared Gemini/Vertex wiring used by every Gemini-backed adapter (Responses and
// asset generation). Credentials and client construction live here once so a new
// adapter routes through the same service-account path instead of re-parsing the
// environment.
export type AdapterEnvironment = Record<string, string | undefined>;
// `caches` is included for explicit context caching of the planner's stable prompt head — the system
// instruction and the declared tools; the real GoogleGenAI client provides it, so the default factory
// satisfies this without change.
export type GeminiClient = Pick<GoogleGenAI, "models" | "caches">;
export type GeminiClientFactory = (options: GoogleGenAIOptions) => GeminiClient;

const vertexLocation = "global";
const vertexAIScope = "https://www.googleapis.com/auth/cloud-platform";
// Client-side request timeout so a stalled upstream call aborts instead of hanging
// the caller (e.g. a harness step) forever. Generous enough to clear a slow 4K
// image generation while still bounding a true hang.
const requestTimeoutMs = 120_000;

export function defaultGeminiClientFactory(options: GoogleGenAIOptions): GeminiClient {
  return new GoogleGenAI(options);
}

// Env vars @google/genai treats as an implicit API key.
const geminiApiKeyEnvVars = ["GEMINI_API_KEY", "GOOGLE_API_KEY"] as const;

// Build a Gemini client with the implicit API-key env vars scrubbed for the span
// of construction. In Vertex mode we authenticate as a service-account principal,
// but the SDK's interactions (NextGen) sub-client re-reads GEMINI_API_KEY /
// GOOGLE_API_KEY from the process environment as an auth fallback and sends it as
// `x-goog-api-key` before ever trying the Vertex JWT — and Vertex rejects API keys
// (401 CREDENTIALS_MISSING). Constructing with those vars absent bakes the
// sub-client's key to null, so its auth falls through to the JWT. `realize` forces
// the lazily-built sub-client into existence inside the window; the scrub and
// restore are fully synchronous, so no concurrent request observes the gap.
export function constructGeminiClient<T>(
  options: GoogleGenAIOptions,
  construct: (options: GoogleGenAIOptions) => T,
  realize?: (client: T) => void,
): T {
  if (!options.vertexai) {
    return construct(options);
  }
  const saved = geminiApiKeyEnvVars.map(
    (name) => [name, process.env[name]] as const,
  );
  for (const [name] of saved) {
    delete process.env[name];
  }
  try {
    const client = construct(options);
    realize?.(client);
    return client;
  } finally {
    for (const [name, value] of saved) {
      if (value !== undefined) {
        process.env[name] = value;
      }
    }
  }
}

export function geminiClientConfig(environment: AdapterEnvironment): {
  configured: boolean;
  options: GoogleGenAIOptions;
  service: "vertex-ai";
} {
  const googleCredentials = googleCredentialsFromEnvironment(environment);
  const project = googleCredentials?.project_id;

  const options: GoogleGenAIOptions = {
    vertexai: true,
    location: vertexLocation,
    httpOptions: { timeout: requestTimeoutMs },
  };
  if (project) {
    options.project = project;
  }
  if (googleCredentials) {
    options.googleAuthOptions = {
      authClient: googleAuthClient(googleCredentials),
    };
  }

  return {
    configured: Boolean(project),
    options,
    service: "vertex-ai",
  };
}

function googleCredentialsFromEnvironment(
  environment: AdapterEnvironment,
): JWTInput | undefined {
  const rawCredentials = environment.GOOGLE_APPLICATION_CREDENTIALS_JSON?.trim();
  if (!rawCredentials) {
    return undefined;
  }

  return serviceAccountCredentials(rawCredentials);
}

function googleAuthClient(credentials: JWTInput) {
  return new JWT({
    email: credentials.client_email,
    key: credentials.private_key,
    keyId: credentials.private_key_id,
    scopes: [vertexAIScope],
  });
}

function serviceAccountCredentials(rawCredentials: string): JWTInput {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawCredentials);
  } catch {
    throw new InferenceProviderError("Google service account JSON is invalid.", {
      statusCode: 500,
      code: "invalid_google_service_account_json",
    });
  }

  const credentials = toJsonValue(parsed);
  if (!isJsonObject(credentials)) {
    throw new InferenceProviderError("Google service account JSON must be an object.", {
      statusCode: 500,
      code: "invalid_google_service_account_json",
    });
  }

  const clientEmail = stringValue(credentials.client_email);
  const privateKey = stringValue(credentials.private_key);
  if (!clientEmail || !privateKey) {
    throw new InferenceProviderError(
      "Google service account JSON must include client_email and private_key.",
      {
        statusCode: 500,
        code: "invalid_google_service_account_json",
      },
    );
  }

  return {
    type: stringValue(credentials.type),
    project_id: stringValue(credentials.project_id),
    private_key_id: stringValue(credentials.private_key_id),
    private_key: privateKey,
    client_email: clientEmail,
    client_id: stringValue(credentials.client_id),
    universe_domain: stringValue(credentials.universe_domain),
  };
}

export function stringValue(value: JsonValue | undefined): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

// Maps a thrown Gemini SDK error to an InferenceProviderError. ApiError.status can be 0 for transport
// failures, so it's clamped to a valid HTTP status the route can serialize. Shared by every Gemini
// adapter; pass the caller's user-facing message.
export function geminiApiError(message: string, error: unknown): InferenceProviderError {
  if (error instanceof ApiError) {
    const status = error.status >= 400 && error.status <= 599 ? error.status : 502;
    return new InferenceProviderError(message, {
      statusCode: status,
      code: "provider_error",
      details: { status: error.status, message: humanApiMessage(error.message) },
    });
  }

  return new InferenceProviderError(message, {
    details: { message: error instanceof Error ? error.message : "Unknown error" },
  });
}

// Vertex wraps the human reason in a JSON body ({"error":{"message":"…"}}) and the SDK
// hands the whole blob back as error.message — sometimes behind a "got status: …" prefix.
// Pull the sentence out so callers surface a clean reason, not raw JSON.
function humanApiMessage(raw: string): string {
  const brace = raw.indexOf("{");
  if (brace >= 0) {
    try {
      const parsed = toJsonValue(JSON.parse(raw.slice(brace)));
      if (isJsonObject(parsed)) {
        const err = parsed.error;
        const nested = isJsonObject(err) ? stringValue(err.message) : undefined;
        return nested ?? stringValue(parsed.message) ?? raw.trim();
      }
    } catch {
      // Not JSON after all — fall through to the raw string.
    }
  }
  return raw.trim();
}

// The candidate objects of a generateContent response, and the content parts of one candidate. Both
// Gemini adapters (text/Responses and image) walk this same candidates → content.parts structure, so
// the traversal lives here once.
export function geminiCandidates(raw: JsonValue): JsonObject[] {
  return isJsonObject(raw) && Array.isArray(raw.candidates)
    ? raw.candidates.filter(isJsonObject)
    : [];
}

export function geminiCandidateParts(candidate: JsonObject | undefined): JsonObject[] {
  if (
    !candidate ||
    !isJsonObject(candidate.content) ||
    !Array.isArray(candidate.content.parts)
  ) {
    return [];
  }
  return candidate.content.parts.filter(isJsonObject);
}
