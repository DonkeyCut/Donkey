# Backend API Guide

Backend APIs are the Next.js route handlers under the site project. They serve
the site's own client views, signed in with a session cookie.

**The one rule:** every route handler is wrapped in `withDonkeyAuth`. A public
endpoint is a deliberate exception with a product reason — today only Better
Auth's own routes, the signature-verified Stripe and Resend webhooks, the
HMAC-token-verified one-click email unsubscribe, and a plain health check. Ship
a handler without the wrapper and the endpoint is open to anyone.

## Authentication

`withDonkeyAuth` takes a session cookie. Inside the handler, `request.donkey`
carries who the caller is. Its `method` field says how they authenticated — by
session cookie or dev bypass — and the handler branches on that, never on the
path.

A route that requires more than being signed in declares the role in the same
wrapper: `withSuperUser(handler)` rejects everyone else with a plain 403 before
the handler runs. Roles are a typed set on the auth options, so a handler never
hand-rolls its own role check.

Better Auth is the login layer, mounted at `/api/auth/[...all]` and configured
in one place. The only interactive login is Google OAuth; email-and-password
stays off unless the product deliberately adds another method. Better Auth's own
Google callback is `${BETTER_AUTH_URL}/api/auth/callback/google`.

**Sign-out is everywhere.** Each browser holds its own session, so signing out on
any surface revokes *every* session for that user (Better Auth's
`revoke-sessions`), not just the current one. Other tabs pick it up when they
refetch the session on focus.

The hosted deploy needs `BETTER_AUTH_URL`, `BETTER_AUTH_SECRET`,
`GOOGLE_CLIENT_ID`, and `GOOGLE_CLIENT_SECRET`. Never commit real OAuth
credentials.

## Handler Rules

- Validate every request body, search param, and route param with Zod before
  using it.
- Check resource ownership before reading or mutating scoped data.
- Return an explicit `NextResponse.json(...)` with the status you mean.
- For an access-control failure — missing session, missing or inactive
  subscription — return a plain 401 via `unauthorizedResponse`; for a missing
  resource, a plain 404 via `notFoundResponse`. Don't hand-write per-case auth
  or not-found messages. Save distinct codes for genuinely different outcomes:
  402 over quota, 429 rate-limited.
- Don't wrap a handler in try/catch unless it can recover and return a different
  intentional response. Let unexpected errors surface to the framework.
- `process.env` holds secrets only: API keys, credentials, and other sensitive
  deploy values. Configuration — model ids, feature switches, tunables — is
  code; write the value where it's used. An env-var fallback like
  `process.env.SOME_MODEL ?? "default"` ships the feature dormant and hides the
  real value from readers.

## Database

- Reach Prisma only through the server-only client; never import it into client
  code.
- Put table and model definitions in grouped sibling `.prisma` files, not in
  `schema.prisma` — that file holds only the generator and datasource config.
- Use Prisma's default table names for new models; don't add `@@map`. A few
  older tables predate this and keep their mapped snake_case names.
- Add `@@index` only for a column a query actually filters or joins on. `@id`
  and `@unique` already index their columns, so a speculative index you never
  query is just write overhead.
- Don't run database migrations as part of API work.

## Inference Gateway

The inference gateway is the client-facing boundary for remote model calls and
asset generation. Everything a client and the backend share — routes, schemas,
the stateless provider calls — stays provider-neutral. Provider names live only
inside private adapters, as configuration and data.

Every inference route requires the `x-donkey-client-id` header. Provider request
mapping lives behind the provider registry, so handlers import the registry and
the neutral schemas, never an individual adapter.

**State stays on the client.** The backend can create or refresh a provider job and
hand back job IDs, generation IDs, polling URLs, and output references, but it
never persists prompts, generation records, provider output references, or
generated assets in Postgres.

**Media never rides the request body.** The routes run as serverless functions
behind a request-body limit the platform enforces at the edge, and an oversized
body is refused before a handler runs — the caller sees a dropped connection, not
an error anyone can act on. So a client with pictures or sound to send uploads
the bytes straight to object storage and puts a placeholder in the body naming
the object and the field the bytes belong in. The route swaps the bytes back in
before the provider call, where the request is server-to-server and only the
model's own limit applies.

Two rules follow. A placeholder is scoped to the account that uploaded it, so a
route reads an object only under the caller's own prefix. And storage is how a
large request succeeds, never why a small one fails: a client that can't reach
storage sends the bytes inline, as it always could.

### Gemini adapter

The Gemini adapter uses the official `@google/genai` SDK. It runs on Vertex AI's
global endpoint only when `GOOGLE_APPLICATION_CREDENTIALS_JSON` carries a
`project_id`; without one, the provider is unavailable. Set that JSON as a
hosted-deploy secret.

Model choice is code (see Handler Rules on `process.env`):

| Call | Model |
|---|---|
| Gate-judged simple chat turns, fast structured decisions | `gemini-3.1-flash-lite` |
| General chat, non-decision structured calls | `gemini-3.7-flash` |

Structured requests normalize their JSON schema for Gemini and retry without a
provider-enforced schema when Vertex rejects the schema parameters.

## Hosted Model Credits

Hosted inference is metered per signed-in user, and the backend owns the meter.
The Mac app sends provider-neutral requests; the backend checks credits, knows
the rates, debits, and writes the audit rows. Each user has one visible balance,
with grants, expirations, usage charges, and adjustments recorded behind it.

A provider-invoking route checks credits before it calls the model and charges
after the provider succeeds. Listing models is free. If the provider or runtime
fails after a successful preflight, the route records a zero-cost failed-usage
event with a sanitized error code.

Manual credit grants go through `POST /api/credits/grants/`. The caller must be
signed in with `user.superUser` set, and the target user is addressed by
internal id. The route reads a whole-dollar amount as credits — `$1` is one
credit, or `1,000,000` micros — then writes the grant and its ledger entry.

Known OpenAI, Gemini, and ElevenLabs models fall back to backend-owned prices
unless a database rate overrides them. The fallbacks mirror current public
provider prices, mark them up by the supported margin, and round up to the
nearest credit micro. Token models charge per million provider tokens; hidden
reasoning or output tokens are billed as output when the provider's
`totalTokens` exceeds visible input plus output. Speech bills by the provider's
returned units; a music render bills flat per generated clip, since the render is
a fixed-length interaction that carries no per-second usage. Keep rate overrides
and per-user limits in backend-owned data, not the Mac app.

**Usage rows store units, never content.** They may keep sanitized provider
usage metadata and normalized billable units. They must not keep prompts,
request bodies, screenshots, generated assets, provider output, output
references, or any other user content.

## Pattern

```typescript
import { NextResponse } from "next/server";

import { withDonkeyAuth } from "@/lib/donkey-api-auth";

export const GET = withDonkeyAuth((request) => {
  return NextResponse.json({
    clientId: request.donkey.clientId,
  });
});
```

## Where It Lives

Backend handlers live under the site project's API routes; the auth wrapper,
Prisma client, and inference adapters live in its lib folder, and table
definitions live in the Prisma folder. Start at the auth wrapper when changing
how a handler authenticates.
