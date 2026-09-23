import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import {
  CLIENT_ID,
  SCOPES,
  resourceUrl,
  type ChatgptConfig,
} from "@/clients/chatgpt/server/config";

export const tokenHash = (value: string) =>
  createHash("sha256").update(value).digest("hex");
export const newToken = () => randomBytes(32).toString("base64url");
export const pkceChallenge = (verifier: string) =>
  createHash("sha256").update(verifier).digest("base64url");
export function sameSecret(a: string, b: string) {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

export const authorizationSchema = z.object({
  response_type: z.literal("code"),
  client_id: z.literal(CLIENT_ID),
  redirect_uri: z.url(),
  scope: z.string().min(1).max(200),
  state: z.string().min(1).max(2048),
  code_challenge: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  code_challenge_method: z.literal("S256"),
  resource: z.url(),
  nonce: z.string().min(1).max(2048).optional(),
  prompt: z.literal("consent").optional(),
});
export type Authorization = z.infer<typeof authorizationSchema>;

export function authorizeInput(
  params: URLSearchParams,
  config: ChatgptConfig,
): Authorization | null {
  if ([...params.keys()].some((key) => params.getAll(key).length !== 1)) {
    return null;
  }
  const parsed = authorizationSchema.safeParse(Object.fromEntries(params));
  if (!parsed.success) {
    return null;
  }
  const input = parsed.data;
  if (!config.redirectUris.includes(input.redirect_uri)) {
    return null;
  }
  if (input.resource !== resourceUrl(config)) {
    return null;
  }
  const scopes = input.scope.split(" ");
  if (!scopes.includes("projects:read")) {
    return null;
  }
  if (scopes.includes("email") && !scopes.includes("openid")) return null;
  if (input.nonce !== undefined && !scopes.includes("openid")) return null;
  const hasUnknownScope = scopes.some(
    (scope) => !SCOPES.some((known) => known === scope),
  );
  if (hasUnknownScope) {
    return null;
  }
  return input;
}

export const exchangeSchema = z.discriminatedUnion("grant_type", [
  z.object({
    grant_type: z.literal("authorization_code"),
    client_id: z.literal(CLIENT_ID),
    resource: z.url(),
    code: z.string().min(32).max(128),
    redirect_uri: z.url(),
    code_verifier: z.string().regex(/^[A-Za-z0-9._~-]{43,128}$/),
  }),
  z.object({
    grant_type: z.literal("refresh_token"),
    client_id: z.literal(CLIENT_ID),
    resource: z.url(),
    refresh_token: z.string().min(32).max(128),
    scope: z.string().optional(),
  }),
]);
export type Exchange = z.infer<typeof exchangeSchema>;
