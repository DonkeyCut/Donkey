import { connection } from "next/server";
import { z } from "zod";
import { getDonkeyAuthContext, withDonkeyAuth } from "@/lib/donkey-api-auth";
import {
  checkInMemoryRateLimit,
  rateLimitResponse,
} from "@/lib/inference/rate-limit";
import { prisma } from "@/lib/prisma";
import {
  CLIENT_ID,
  chatgptConfig,
  OAUTH_PATH,
  PROJECT_SCOPES,
  resourceUrl,
} from "@/clients/chatgpt/server/config";
import {
  authorizationSchema,
  authorizeInput,
  exchangeSchema,
  newToken,
  sameSecret,
  tokenHash,
  type Authorization,
} from "@/clients/chatgpt/server/oauthPolicy";
import {
  createCode,
  exchangeToken,
  revokeToken,
} from "@/clients/chatgpt/server/oauthTokens";

import {
  limitOAuthSource,
  OAuthRateLimitError,
} from "@/clients/chatgpt/server/oauthRateLimit";
import { identitySigner, openIdMetadata } from "@/clients/chatgpt/server/oidc";

const NO_STORE_HEADERS = { "Cache-Control": "no-store", Pragma: "no-cache" };
const CONSENT_COOKIE_NAME = "__Host-donkey-chatgpt-consent";
const consentSchema = z.object({
  nonce: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  decision: z.enum(["allow", "deny"]),
});
const challengeSchema = z.object({
  authorization: authorizationSchema,
  browserTokenHash: z.string().regex(/^[a-f0-9]{64}$/),
});

export async function authorizationMetadata() {
  await connection();
  const config = await chatgptConfig();
  if (!config.enabled) {
    return oauthError("temporarily_unavailable", 503);
  }

  identitySigner();
  return Response.json(openIdMetadata(config), { headers: NO_STORE_HEADERS });
}

/** GET /api/chatgpt/oauth/jwks: public keys for verifying ID tokens. */
export async function identityKeys() {
  await connection();
  const config = await chatgptConfig();
  if (!config.enabled) return oauthError("temporarily_unavailable", 503);
  return Response.json(
    { keys: [identitySigner().jwk] },
    { headers: NO_STORE_HEADERS },
  );
}

export async function protectedResourceMetadata() {
  await connection();
  const config = await chatgptConfig();
  if (!config.enabled) {
    return oauthError("temporarily_unavailable", 503);
  }

  return Response.json(
    {
      resource: resourceUrl(config),
      authorization_servers: [config.issuer],
      scopes_supported: PROJECT_SCOPES,
      bearer_methods_supported: ["header"],
      resource_name: "Donkey Cut",
    },
    { headers: NO_STORE_HEADERS },
  );
}

/** GET /api/chatgpt/oauth/authorize: validate before login or consent. */
export async function authorize(request: Request) {
  const config = await chatgptConfig();
  if (!config.enabled) {
    return oauthError("temporarily_unavailable", 503);
  }

  const searchParams = new URL(request.url).searchParams;
  const authorization = authorizeInput(searchParams, config);
  if (!authorization) {
    return oauthError("invalid_request");
  }

  const identity = await getDonkeyAuthContext(request.headers);
  if (!identity) {
    const loginUrl = new URL("/sign-in", config.issuer);
    loginUrl.searchParams.set(
      "callbackURL",
      `${OAUTH_PATH}/authorize?${searchParams}`,
    );
    return Response.redirect(loginUrl, 303);
  }

  const rateLimit = checkInMemoryRateLimit({
    key: `chatgpt:consent:${identity.userId}`,
    limit: config.requestsPerMinute,
    windowMs: 60_000,
  });
  if (!rateLimit.ok) {
    return rateLimitResponse(rateLimit.retryAfterSeconds);
  }

  const nonce = newToken();
  const browserToken =
    consentBrowserToken(request.headers.get("cookie")) ?? newToken();
  const identifier = `chatgpt-consent:${identity.userId}`;
  await prisma.verification.deleteMany({
    where: { identifier, expiresAt: { lte: new Date() } },
  });
  await prisma.verification.create({
    data: {
      id: `chatgpt:${tokenHash(nonce)}`,
      identifier,
      value: JSON.stringify({
        authorization,
        browserTokenHash: tokenHash(browserToken),
      }),
      expiresAt: new Date(Date.now() + 600_000),
    },
  });

  return consentPage(nonce, authorization, browserToken);
}

/** POST /api/chatgpt/oauth/authorize: explicit, browser-bound consent. */
export const consent = withDonkeyAuth(async (request) => {
  const config = await chatgptConfig();
  if (!config.enabled) {
    return oauthError("temporarily_unavailable", 503);
  }
  if (request.headers.get("origin") !== config.issuer) {
    return oauthError("invalid_request");
  }

  const form = await readOAuthForm(request);
  if (!form) {
    return oauthError("invalid_request");
  }
  const parsed = consentSchema.safeParse(Object.fromEntries(form));
  if (!parsed.success) {
    return oauthError("invalid_request");
  }
  const { nonce, decision } = parsed.data;

  const browserToken = consentBrowserToken(request.headers.get("cookie"));
  if (!browserToken) return expiredConsent();

  const challengeId = `chatgpt:${tokenHash(nonce)}`;
  const challenge = await prisma.verification.findUnique({
    where: { id: challengeId },
  });
  if (!challenge || challenge.expiresAt <= new Date()) {
    return expiredConsent();
  }
  if (challenge.identifier !== `chatgpt-consent:${request.donkey.userId}`) {
    return expiredConsent();
  }

  // Revalidate against current settings before issuing a code.
  const parsedChallenge = challengeSchema.safeParse(
    JSON.parse(challenge.value),
  );
  if (
    !parsedChallenge.success ||
    !sameSecret(parsedChallenge.data.browserTokenHash, tokenHash(browserToken))
  ) {
    return expiredConsent();
  }
  const { authorization } = parsedChallenge.data;
  if (!authorizeInput(new URLSearchParams(authorization), config)) {
    return oauthError("invalid_request");
  }

  const consumed = await prisma.verification.deleteMany({
    where: { id: challengeId, expiresAt: { gt: new Date() } },
  });
  if (!consumed.count) {
    return expiredConsent();
  }

  const callbackUrl = new URL(authorization.redirect_uri);
  callbackUrl.searchParams.set("state", authorization.state);
  callbackUrl.searchParams.set("iss", config.issuer);
  if (decision === "deny") {
    callbackUrl.searchParams.set("error", "access_denied");
  } else {
    const code = await createCode(request.donkey.userId, authorization, config);
    callbackUrl.searchParams.set("code", code);
  }

  return new Response(null, {
    status: 303,
    headers: {
      ...NO_STORE_HEADERS,
      Location: callbackUrl.href,
    },
  });
});

/** POST /api/chatgpt/oauth/token: authenticate with the submitted code or refresh token. */
export async function tokenEndpoint(request: Request) {
  const config = await chatgptConfig();
  if (!config.enabled) {
    return oauthError("temporarily_unavailable", 503);
  }

  const limited = limitOAuthSource(
    request,
    "token",
    config.oauthRequestsPerIpMinute,
  );
  if (limited) return limited;

  const form = await readOAuthForm(request);
  const input = exchangeSchema.safeParse(
    form ? Object.fromEntries(form) : null,
  );
  if (!input.success) {
    return oauthError("invalid_request");
  }

  try {
    const tokens = await exchangeToken(input.data, config);
    if (!tokens) return oauthError("invalid_grant");
    return Response.json(tokens, { headers: NO_STORE_HEADERS });
  } catch (error) {
    if (error instanceof OAuthRateLimitError) {
      return rateLimitResponse(error.retryAfterSeconds);
    }
    throw error;
  }
}

/** POST /api/chatgpt/oauth/revoke: revoke the connection owning the submitted token. */
export async function revocationEndpoint(request: Request) {
  const config = await chatgptConfig();
  if (!config.enabled) {
    return oauthError("temporarily_unavailable", 503);
  }

  const limited = limitOAuthSource(
    request,
    "revoke",
    config.oauthRequestsPerIpMinute,
  );
  if (limited) return limited;

  const form = await readOAuthForm(request);
  if (form?.get("client_id") !== CLIENT_ID) {
    return oauthError("invalid_client");
  }

  const token = z
    .string()
    .regex(/^[A-Za-z0-9_-]{43}$/)
    .safeParse(form.get("token"));
  try {
    if (token.success) await revokeToken(token.data, config);
    return new Response(null, { status: 200, headers: NO_STORE_HEADERS });
  } catch (error) {
    if (error instanceof OAuthRateLimitError) {
      return rateLimitResponse(error.retryAfterSeconds);
    }
    throw error;
  }
}

async function readOAuthForm(
  request: Request,
): Promise<URLSearchParams | null> {
  const contentType = request.headers.get("content-type");
  if (!contentType?.startsWith("application/x-www-form-urlencoded")) {
    return null;
  }

  const reader = request.body?.getReader();
  if (!reader) {
    return null;
  }

  const chunks: Uint8Array[] = [];
  let byteLength = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      byteLength += value.length;
      if (byteLength > 8192) {
        await reader.cancel();
        return null;
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const form = new URLSearchParams(Buffer.concat(chunks).toString("utf8"));
  const hasRepeatedFields = [...form.keys()].some(
    (key) => form.getAll(key).length !== 1,
  );
  return hasRepeatedFields ? null : form;
}

function oauthError(error: string, status = 400) {
  return Response.json({ error }, { status, headers: NO_STORE_HEADERS });
}

function consentCookie(value: string, maxAgeSeconds: number) {
  return `${CONSENT_COOKIE_NAME}=${value}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAgeSeconds}`;
}

function consentBrowserToken(header: string | null) {
  const matches = header
    ?.split(";")
    .map((cookie) => cookie.trim())
    .filter((cookie) => cookie.startsWith(`${CONSENT_COOKIE_NAME}=`));
  const value =
    matches?.length === 1
      ? matches[0].slice(CONSENT_COOKIE_NAME.length + 1)
      : undefined;
  return value && /^[A-Za-z0-9_-]{43}$/.test(value) ? value : null;
}

function expiredConsent() {
  return new Response(
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Restart connection</title></head><body><h1>Start the connection again</h1><p>This connection page expired or your signed-in account changed. Return to OpenAI and start the connection again.</p></body></html>`,
    {
      status: 400,
      headers: {
        ...NO_STORE_HEADERS,
        "Content-Type": "text/html; charset=utf-8",
        "Content-Security-Policy":
          "default-src 'none'; frame-ancestors 'none'; base-uri 'none'",
      },
    },
  );
}

function consentPage(
  nonce: string,
  authorization: Authorization,
  browserToken: string,
) {
  const scopes = authorization.scope.split(" ");
  const access = scopes.includes("projects:write") ? "view and edit" : "view";
  const escapedNonce = nonce.replace(
    /[&<>"']/g,
    (character) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;",
      })[character]!,
  );
  const html = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width,initial-scale=1">
    <title>Connect to ChatGPT</title>
    <style>
      body { font: 17px system-ui; max-width: 460px; margin: 12vh auto; padding: 24px; color: #202020; background: #faf9f7; }
      h1 { display: flex; align-items: center; gap: 14px; font-size: 34px; margin: 0 0 20px; }
      h1 img { width: 56px; height: 56px; }
      p { line-height: 1.6; margin: 0 0 24px; }
      button { font: inherit; padding: 12px 20px; border-radius: 10px; border: 1px solid #ccc; cursor: pointer; }
      button[value=allow] { background: #202020; color: white; }
      form { display: flex; gap: 12px; }
    </style>
  </head>
  <body>
    <h1><img src="/donkey-logo.svg" alt="">Donkey Cut</h1>
    <p>ChatGPT can ${access} your projects${scopes.includes("openid") ? ` and read your account information${scopes.includes("email") ? ", including your email address" : ""}` : ""}.</p>
    <form method="post" action="${OAUTH_PATH}/authorize">
      <input type="hidden" name="nonce" value="${escapedNonce}">
      <button name="decision" value="allow">Connect</button>
      <button name="decision" value="deny">Cancel</button>
    </form>
  </body>
</html>`;

  // Chromium applies form-action to the redirect after the consent POST, too.
  const callbackOrigin = new URL(authorization.redirect_uri).origin;
  const contentSecurityPolicy = [
    "default-src 'none'",
    "img-src 'self'",
    "style-src 'unsafe-inline'",
    `form-action 'self' ${callbackOrigin}`,
    "frame-ancestors 'none'",
    "base-uri 'none'",
  ].join("; ");

  return new Response(html, {
    headers: {
      ...NO_STORE_HEADERS,
      "Content-Type": "text/html; charset=utf-8",
      "Set-Cookie": consentCookie(browserToken, 600),
      "Content-Security-Policy": contentSecurityPolicy,
      // Preserve the same-origin POST's Origin for consent validation.
      "Referrer-Policy": "strict-origin-when-cross-origin",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
