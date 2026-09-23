import { serializeSignedCookie } from "better-call";
import { auth } from "@/lib/auth";
import { chatgptConfig } from "@/clients/chatgpt/server/config";
import {
  enforceOAuthUserLimit,
  limitOAuthSource,
  OAuthRateLimitError,
} from "@/clients/chatgpt/server/oauthRateLimit";
import { recordEditorSession, redeemEditorCode } from "@/clients/chatgpt/server/oauthTokens";

const NO_STORE_HEADERS = { "Cache-Control": "no-store", Pragma: "no-cache" };

/**
 * A page the frame shows in place of the editor. The card draws the editor's
 * skeleton over the frame until the frame says it has something to show, so
 * every answer here is either the editor or a page that says so.
 */
function refusal(message: string, status: number, retryAfter?: string) {
  const page = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Donkey Cut</title></head><body style="margin:0;min-height:100vh;display:grid;place-items:center;padding:24px;box-sizing:border-box;background:#fff;color:#737373;font:14px/1.5 system-ui,sans-serif;text-align:center"><p>${message}</p><script>parent.postMessage({ type: "donkeycut:ready" }, "*")</script></body></html>`;
  return new Response(page, {
    status,
    headers: {
      ...NO_STORE_HEADERS,
      ...(retryAfter && { "Retry-After": retryAfter }),
      "Content-Type": "text/html; charset=utf-8",
    },
  });
}

const TOO_MANY = "Too many requests. Try again in a minute.";

/**
 * GET /api/chatgpt/embed?code=…&project=…: the card's frame redeems its one-use
 * code for a session and lands on the editor. The session cookie is
 * partitioned, so it exists only inside that frame under ChatGPT: the account's
 * own sign-in never crosses into the frame, and the frame's never leaves it.
 */
export async function embedEndpoint(request: Request) {
  try {
    return await redeem(request);
  } catch (error) {
    console.error("[chatgpt] embed redeem failed", error);
    return refusal("Donkey Cut could not open the editor. Open the project again from ChatGPT.", 500);
  }
}

async function redeem(request: Request) {
  const config = await chatgptConfig();
  if (!config.enabled) return refusal("ChatGPT connection is not enabled.", 503);
  const limited = limitOAuthSource(request, "embed", config.oauthRequestsPerIpMinute);
  if (limited) return refusal(TOO_MANY, 429, limited.headers.get("Retry-After") ?? undefined);

  const params = new URL(request.url).searchParams;
  const project = params.get("project") ?? "";
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(project)) return refusal("Bad request.", 400);
  const redeemed = await redeemEditorCode(params.get("code") ?? "", config);
  if (!redeemed) return refusal("This editor link has expired. Open the project again from ChatGPT.", 403);
  try {
    enforceOAuthUserLimit(redeemed.userId, "embed", config.requestsPerMinute);
  } catch (error) {
    if (error instanceof OAuthRateLimitError) return refusal(TOO_MANY, 429, String(error.retryAfterSeconds));
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
