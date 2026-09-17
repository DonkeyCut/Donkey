import { serializeSignedCookie } from "better-call";
import { auth } from "@/lib/auth";
import { rateLimitResponse } from "@/lib/inference/rate-limit";
import { chatgptConfig } from "@/clients/chatgpt/server/config";
import {
  enforceOAuthUserLimit,
  limitOAuthSource,
  OAuthRateLimitError,
} from "@/clients/chatgpt/server/oauthRateLimit";
import { recordEditorSession, redeemEditorCode } from "@/clients/chatgpt/server/oauthTokens";

const NO_STORE_HEADERS = { "Cache-Control": "no-store", Pragma: "no-cache" };

/**
 * GET /api/chatgpt/embed?code=…&project=…: the card's frame redeems its one-use
 * code for a session and lands on the editor. The session cookie is
 * partitioned, so it exists only inside that frame under ChatGPT: the account's
 * own sign-in never crosses into the frame, and the frame's never leaves it.
 */
export async function embedEndpoint(request: Request) {
  const config = await chatgptConfig();
  if (!config.enabled) {
    return new Response("ChatGPT connection is not enabled.", { status: 503, headers: NO_STORE_HEADERS });
  }
  const limited = limitOAuthSource(request, "embed", config.oauthRequestsPerIpMinute);
  if (limited) return limited;

  const params = new URL(request.url).searchParams;
  const project = params.get("project") ?? "";
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(project)) {
    return new Response("Bad request.", { status: 400, headers: NO_STORE_HEADERS });
  }
  const redeemed = await redeemEditorCode(params.get("code") ?? "", config);
  if (!redeemed) {
    return new Response("This editor link has expired. Open the project again from ChatGPT.", {
      status: 403,
      headers: { ...NO_STORE_HEADERS, "Content-Type": "text/plain; charset=utf-8" },
    });
  }
  try {
    enforceOAuthUserLimit(redeemed.userId, "embed", config.requestsPerMinute);
  } catch (error) {
    if (error instanceof OAuthRateLimitError) return rateLimitResponse(error.retryAfterSeconds);
    throw error;
  }

  const context = await auth.$context;
  const expiresAt = new Date(Date.now() + config.editorSessionHours * 3_600_000);
  const session = await context.internalAdapter.createSession(redeemed.userId, false, { expiresAt }, true);
  await recordEditorSession(redeemed.grantId, { id: session.id, expiresAt: session.expiresAt });
  const { name, attributes } = context.authCookies.sessionToken;
  const cookie = await serializeSignedCookie(name, session.token, context.secret, {
    ...attributes,
    secure: true,
    sameSite: "none",
    partitioned: true,
    maxAge: config.editorSessionHours * 3600,
  });
  return new Response(null, {
    status: 303,
    headers: {
      ...NO_STORE_HEADERS,
      "Set-Cookie": cookie,
      Location: `${config.issuer}/app/p/${encodeURIComponent(project)}?embed=chatgpt`,
    },
  });
}
