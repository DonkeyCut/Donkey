import { type NextRequest, NextResponse } from "next/server";

import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

export type DonkeyAuthContext = {
  platform: "api";
  app: "donkey";
  method: "session-cookie" | "dev-bypass" | "api-key";
  clientId: string | null;
  // The app's active conversation for this request, from x-donkey-conversation-id.
  // Null for background work (vision warming) and non-app callers (Vision API keys).
  conversationId: string | null;
  userId: string;
  apiKeyId: string | null;
};

// The known roles a route can require beyond being signed in. Add new roles
// here so every requirement stays part of this one typed set.
export type DonkeyRole = "SUPER_USER";

export type DonkeyAuthOptions = {
  // Routes are session-only by default. Set true to also accept a Vision API
  // key as a bearer token. This is the typed allowlist for "which routes
  // support API keys" — no path string matching.
  allowApiKey?: boolean;
  // When set, the authenticated user must hold this role or the request is
  // rejected with 403 before the handler runs.
  role?: DonkeyRole;
};

export type DonkeyAuthenticatedRequest = NextRequest & {
  donkey: DonkeyAuthContext;
};

// The real signed-in user's id, or null for api-key / dev-bypass callers. Use
// this in session-only product routes (billing, API-key management) instead of
// re-calling auth.api.getSession — withDonkeyAuth already authenticated.
export function donkeySessionUserId(
  request: DonkeyAuthenticatedRequest,
): string | null {
  return request.donkey.method === "session-cookie"
    ? request.donkey.userId
    : null;
}

// The single response for any access-control failure (no session, no
// subscription). Routes return this rather than per-case descriptive errors.
export function unauthorizedResponse() {
  return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
}

// Generic 404 for any missing resource. Routes return this rather than per-case
// descriptive not-found errors.
export function notFoundResponse() {
  return NextResponse.json({ error: "Not found" }, { status: 404 });
}

// Generic 403 for a signed-in caller without the role a route requires.
export function forbiddenResponse() {
  return NextResponse.json({ error: "Forbidden" }, { status: 403 });
}

// True when the request comes from Vercel's cron scheduler, which sends the
// project's CRON_SECRET env var as a bearer token on every invocation.
export function isVercelCron(request: Request): boolean {
  const secret = process.env.CRON_SECRET;
  return !!secret && request.headers.get("authorization") === `Bearer ${secret}`;
}

export type DonkeyAuthHandler<
  TReq extends DonkeyAuthenticatedRequest = DonkeyAuthenticatedRequest,
  TArgs extends unknown[] = [],
> = (request: TReq, ...args: TArgs) => Promise<Response> | Response;

const clientIdHeader = "x-donkey-client-id";
const conversationIdHeader = "x-donkey-conversation-id";
const devAuthBypassHeader = "x-donkey-dev-auth-bypass";
const devAuthBypassUserID = "donkey-dev-auth-bypass";

function conversationIdFromHeaders(headers: Headers): string | null {
  const value = headers.get(conversationIdHeader)?.trim();
  return value ? value : null;
}

export async function getDonkeyAuthContext(
  headers: Headers,
): Promise<DonkeyAuthContext | null> {
  const devBypass = devAuthBypassContext(headers);
  if (devBypass) {
    return devBypass;
  }

  const apiKeyContext = await apiKeyAuthContext(headers);
  if (apiKeyContext) {
    return apiKeyContext;
  }

  const session = await auth.api.getSession({
    headers,
  });
  if (!session) {
    return null;
  }

  const clientId = headers.get(clientIdHeader)?.trim();

  return {
    platform: "api",
    app: "donkey",
    method: "session-cookie",
    clientId: clientId ? clientId : null,
    conversationId: conversationIdFromHeaders(headers),
    userId: session.user.id,
    apiKeyId: null,
  };
}

// Vision API keys are sent as a bearer token; that is the only accepted format.
function apiKeyFromHeaders(headers: Headers): string | null {
  const authorization = headers.get("authorization")?.trim();
  if (!authorization?.toLowerCase().startsWith("bearer ")) {
    return null;
  }

  const token = authorization.slice("bearer ".length).trim();
  return token ? token : null;
}

async function apiKeyAuthContext(
  headers: Headers,
): Promise<DonkeyAuthContext | null> {
  const key = apiKeyFromHeaders(headers);
  if (!key) {
    return null;
  }

  const verified = await auth.api.verifyApiKey({ body: { key } });
  if (!verified.valid || !verified.key) {
    return null;
  }

  const clientId = headers.get(clientIdHeader)?.trim();

  return {
    platform: "api",
    app: "donkey",
    method: "api-key",
    // The Vision API does not require x-donkey-client-id; default it to the key
    // id so downstream usage records and rate-limit buckets stay per-key.
    clientId: clientId ? clientId : verified.key.id,
    // Vision API keys have no app conversation; honor the header if sent, else null.
    conversationId: conversationIdFromHeaders(headers),
    userId: verified.key.referenceId,
    apiKeyId: verified.key.id,
  };
}

export function shouldBypassDonkeyInferenceCredits(
  authContext: DonkeyAuthContext,
) {
  return authContext.method === "dev-bypass";
}

function devAuthBypassContext(headers: Headers): DonkeyAuthContext | null {
  if (process.env.NODE_ENV === "production") {
    return null;
  }
  if (headers.get(devAuthBypassHeader)?.trim() !== "1") {
    return null;
  }

  const clientId = headers.get(clientIdHeader)?.trim();

  return {
    platform: "api",
    app: "donkey",
    method: "dev-bypass",
    clientId: clientId ? clientId : null,
    conversationId: conversationIdFromHeaders(headers),
    userId: devAuthBypassUserID,
    apiKeyId: null,
  };
}

export function withDonkeyAuth<
  TReq extends DonkeyAuthenticatedRequest = DonkeyAuthenticatedRequest,
  TArgs extends unknown[] = [],
>(handler: DonkeyAuthHandler<TReq, TArgs>, options: DonkeyAuthOptions = {}) {
  return async (request: NextRequest, ...args: TArgs) => {
    const authContext = await getDonkeyAuthContext(request.headers);

    if (!authContext) {
      return NextResponse.json(
        {
          error: "Unauthorized",
          message: "Authentication required",
        },
        {
          status: 401,
        },
      );
    }

    if (authContext.method === "api-key" && !options.allowApiKey) {
      return NextResponse.json(
        {
          error: "api_key_not_permitted_for_route",
          message: "API keys are not accepted on this route.",
        },
        {
          status: 401,
        },
      );
    }

    if (
      options.role === "SUPER_USER" &&
      !(await isDonkeySuperUser(authContext.userId))
    ) {
      return forbiddenResponse();
    }

    const authenticatedRequest = Object.assign(request, {
      donkey: authContext,
    }) as TReq;

    return handler(authenticatedRequest, ...args);
  };
}

// Superuser-only route: withDonkeyAuth with the SUPER_USER role required.
//   export const POST = withSuperUser(async (request) => { ... });
export function withSuperUser<
  TReq extends DonkeyAuthenticatedRequest = DonkeyAuthenticatedRequest,
  TArgs extends unknown[] = [],
>(
  handler: DonkeyAuthHandler<TReq, TArgs>,
  options: Omit<DonkeyAuthOptions, "role"> = {},
) {
  return withDonkeyAuth(handler, { ...options, role: "SUPER_USER" });
}

export async function isDonkeySuperUser(userId: string) {
  const user = await prisma.user.findUnique({
    select: {
      superUser: true,
    },
    where: {
      id: userId,
    },
  });

  return user?.superUser === true;
}
