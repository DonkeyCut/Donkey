import { createHash, timingSafeEqual } from "node:crypto";
import { type NextRequest, NextResponse } from "next/server";

import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

export type DonkeyAuthContext = {
  platform: "api";
  app: "donkey";
  method: "session-cookie" | "dev-bypass" | "runner" | "api-key";
  clientId: string | null;
  // The app's active conversation for this request, from x-donkey-conversation-id.
  // Null for background work.
  conversationId: string | null;
  userId: string;
};

// The known roles a route can require beyond being signed in. Add new roles
// here so every requirement stays part of this one typed set.
export type DonkeyRole = "SUPER_USER";

export type DonkeyAuthOptions = {
  // When set, the authenticated user must hold this role or the request is
  // rejected with 403 before the handler runs.
  role?: DonkeyRole;
  // Accept a `dk_live_` bearer key as the user. Off by default: only routes
  // that opt in (the Cut API surface) take machine callers.
  allowApiKey?: boolean;
  // Accept the Cut runner's shared-secret grant. Off by default: only the
  // routes the worker actually calls back (the Cut API surface and hosted
  // inference) opt in, so a leaked secret stays contained to them.
  allowRunner?: boolean;
};

export type DonkeyAuthenticatedRequest = NextRequest & {
  donkey: DonkeyAuthContext;
};

// The real signed-in user's id, or null for dev-bypass callers. Use this in
// session-only product routes (billing) instead of re-calling
// auth.api.getSession — withDonkeyAuth already authenticated.
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
  options: { allowApiKey?: boolean; allowRunner?: boolean } = {},
): Promise<DonkeyAuthContext | null> {
  const devBypass = devAuthBypassContext(headers);
  if (devBypass) {
    return devBypass;
  }
  if (options.allowRunner) {
    const runner = runnerAuthContext(headers);
    if (runner) {
      return runner;
    }
  }
  if (options.allowApiKey) {
    const apiKey = await apiKeyAuthContext(headers);
    if (apiKey) {
      return apiKey;
    }
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
  };
}

export function shouldBypassDonkeyInferenceCredits(
  authContext: DonkeyAuthContext,
) {
  return authContext.method === "dev-bypass";
}

export const API_KEY_PREFIX = "dk_live_";

/** The stored form of an API key: SHA-256 hex of the whole secret. */
export function hashApiKey(secret: string): string {
  return createHash("sha256").update(secret).digest("hex");
}

/** A machine caller holding a per-user key: `Authorization: Bearer dk_live_…`.
 * Rows live in the Better-Auth-shaped Apikey table (`key` holds the SHA-256
 * of the whole secret, `referenceId` the owner), so the plugin can take the
 * table over unchanged when it ships. The lookup is by hash; the table never
 * holds a usable secret. */
async function apiKeyAuthContext(headers: Headers): Promise<DonkeyAuthContext | null> {
  const header = headers.get("authorization");
  const secret = header?.startsWith("Bearer ") ? header.slice(7).trim() : null;
  if (!secret || !secret.startsWith(API_KEY_PREFIX)) return null;
  const row = await prisma.apikey.findFirst({
    where: { key: hashApiKey(secret) },
    select: { id: true, referenceId: true, enabled: true, expiresAt: true },
  });
  if (!row || row.enabled === false) return null;
  if (row.expiresAt && row.expiresAt.getTime() < Date.now()) return null;
  void prisma.apikey
    .update({
      where: { id: row.id },
      data: { lastRequest: new Date(), requestCount: { increment: 1 } },
    })
    .catch(() => {});
  const clientId = headers.get(clientIdHeader)?.trim();
  return {
    platform: "api",
    app: "donkey",
    method: "api-key",
    clientId: clientId ? clientId : null,
    conversationId: conversationIdFromHeaders(headers),
    userId: row.referenceId,
  };
}

const runnerSecretHeader = "x-donkey-runner-secret";
const runnerUserHeader = "x-donkey-runner-user";

/** The Cut runner acting for one user: the worker container executes a job
 * the hosted API queued for that user, and calls back with the shared secret
 * plus the job's user id. The secret is the whole grant, so it compares in
 * constant time and both headers are required. */
function runnerAuthContext(headers: Headers): DonkeyAuthContext | null {
  const secret = process.env.CUT_RUNNER_SECRET;
  const got = headers.get(runnerSecretHeader);
  const userId = headers.get(runnerUserHeader)?.trim();
  if (!secret || !got || !userId) return null;
  const a = Buffer.from(got);
  const b = Buffer.from(secret);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  const clientId = headers.get(clientIdHeader)?.trim();
  return {
    platform: "api",
    app: "donkey",
    method: "runner",
    clientId: clientId ? clientId : null,
    conversationId: conversationIdFromHeaders(headers),
    userId,
  };
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
  };
}

export function withDonkeyAuth<
  TReq extends DonkeyAuthenticatedRequest = DonkeyAuthenticatedRequest,
  TArgs extends unknown[] = [],
>(handler: DonkeyAuthHandler<TReq, TArgs>, options: DonkeyAuthOptions = {}) {
  return async (request: NextRequest, ...args: TArgs) => {
    const authContext = await getDonkeyAuthContext(request.headers, {
      allowApiKey: options.allowApiKey,
      allowRunner: options.allowRunner,
    });

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
