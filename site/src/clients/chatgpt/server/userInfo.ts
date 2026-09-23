import { prisma } from "@/lib/prisma";
import {
  chatgptConfig,
  type ChatgptConfig,
} from "@/clients/chatgpt/server/config";
import { identityClaims } from "@/clients/chatgpt/server/oidc";
import { accessIdentity } from "@/clients/chatgpt/server/oauthTokens";
import {
  enforceOAuthUserLimit,
  limitOAuthSource,
  OAuthRateLimitError,
} from "@/clients/chatgpt/server/oauthRateLimit";
import { rateLimitResponse } from "@/lib/inference/rate-limit";

const HEADERS = { "Cache-Control": "no-store", Pragma: "no-cache" };

function denied(error: "invalid_token" | "insufficient_scope") {
  return Response.json(
    { error },
    {
      status: error === "invalid_token" ? 401 : 403,
      headers: {
        ...HEADERS,
        "WWW-Authenticate": `Bearer error="${error}"${error === "insufficient_scope" ? ', scope="openid"' : ""}`,
      },
    },
  );
}

export async function userInfoResponse(
  request: Request,
  config: ChatgptConfig,
  db = prisma,
) {
  if (!config.enabled)
    return Response.json(
      { error: "temporarily_unavailable" },
      { status: 503, headers: HEADERS },
    );
  const limited = limitOAuthSource(
    request,
    "userinfo",
    config.oauthRequestsPerIpMinute,
  );
  if (limited) return limited;
  const bearer = /^Bearer ([A-Za-z0-9_-]{43})$/i.exec(
    request.headers.get("authorization") ?? "",
  )?.[1];
  const identity = bearer ? await accessIdentity(bearer, config, db) : null;
  if (!identity) return denied("invalid_token");
  if (!identity.scopes.includes("openid")) return denied("insufficient_scope");
  try {
    enforceOAuthUserLimit(
      identity.userId,
      "userinfo",
      config.requestsPerMinute,
    );
  } catch (error) {
    if (error instanceof OAuthRateLimitError)
      return rateLimitResponse(error.retryAfterSeconds);
    throw error;
  }
  const user = await db.user.findUnique({
    where: { id: identity.userId },
    select: { id: true, email: true, emailVerified: true },
  });
  return user
    ? Response.json(identityClaims(user, identity.scopes), { headers: HEADERS })
    : denied("invalid_token");
}

/** GET/POST /api/chatgpt/oauth/userinfo: identity shared by this OAuth grant. */
export async function userInfoEndpoint(request: Request) {
  return userInfoResponse(request, await chatgptConfig());
}
