# ChatGPT App

The ChatGPT app connects a Donkey Cut account, lists its cloud projects, and plays
rendered previews inside the conversation. ChatGPT chooses the tools; Donkey Cut
checks ownership and renders the saved project revision.

**The one rule:** the ChatGPT adapter lives under `site/src/clients/chatgpt`.
Shared rendering stays in Cut, and reusable playback lives in a workspace package.

```text
ChatGPT tools and embedded preview
              ↓
Scoped OAuth connection
              ↓
Cloud project and preview services
              ↓
Captured document → worker renderer → signed media
```

## Client boundaries

The standalone widget imports `@donkeycut/artifact-player/ArtifactVideo`, the
same player used by website previews and shared videos. The package owns video
buffers, visibility handling, and teardown. HLS loads on demand. The widget's
hashed assets are built by `npm run chatgpt:build`, which also runs before the
site's development and production builds. Rebuild it after editing widget code.

The MCP adapter exposes project listing, project opening, preview rendering,
and render status. Its schemas and widget data types share one contract. Signed
media URLs travel in tool-result metadata, which reaches the widget. The model
gets project metadata, render state, and an Open in Donkey Cut link.

Cloud previews use the existing headless renderer and a captured document.
Repeated requests for the same saved revision reuse a queued, running, or
available completed preview. A collected preview can be rendered again.
Browser and Mac projects retain their existing render paths; they become
accessible to ChatGPT after the user saves them to the cloud in Donkey Cut.

The widget polls while visible and renews expiring playback URLs through the
host bridge. It has no account cookie or OAuth token. Preview rendering uses
no Donkey Cut AI credits. Derived previews remain exempt from storage quota;
retained media uses the account's existing storage allowance.

## Account linking

Donkey Cut is the OAuth authorization server and MCP resource server. The account
owner signs in and explicitly grants access on Donkey Cut. Consent is bound to the
browser, account, callback, requested scopes, resource, and S256 challenge.

Each connection owns a token family. Codes are single use; refresh tokens
rotate. A replay revokes the family. Tokens are stored as hashes, and every
MCP request checks expiration, revocation, resource, and scope. Revocation
invalidates subsequent tool calls. Already issued media links retain their
normal short lifetime. The daily authenticated cleanup removes expired grants
and their tokens.

Token exchange and revocation have separate per-user request budgets. Hosted
requests also have per-source abuse limits using Vercel's forwarded address.
Local servers without that address use the authenticated user limits. Source
limits are configured through `chatgptApp.oauthRequestsPerIpMinute`.

| Endpoint | Purpose |
| --- | --- |
| `/api/chatgpt/mcp` | Stateless MCP over HTTP POST |
| `/.well-known/oauth-authorization-server` | OAuth server discovery |
| `/.well-known/oauth-protected-resource/api/chatgpt/mcp` | MCP resource discovery |
| `/api/chatgpt/oauth/authorize` | Login and explicit consent |
| `/api/chatgpt/oauth/token` | Code exchange and refresh rotation |
| `/api/chatgpt/oauth/revoke` | Revoke a connection using its credential |

## Deployment and verification

The integration defaults to disabled in the `chatgptApp` setting. Deploy the
Prisma models in `site/prisma/Chatgpt.prisma` through the project's database
release process, deploy the site and cloud worker, then enable the setting in
su. Generating the Prisma client does not deploy those tables.

Set the same `CUT_RUNNER_SECRET` on the hosted site and the
`donkey-cut-worker` Cloudflare Worker before deployment. The Worker passes it
to the render container so document-backed renders can read media and fonts
through the authenticated hosted API.

Create a ChatGPT developer-mode app pointing at
`https://donkeycut.com/api/chatgpt/mcp`. Use the predefined public OAuth client
ID `donkey-chatgpt`, no client secret, and scopes `projects:read previews:render`.
Configure the exact redirect URI supplied by ChatGPT in `chatgptApp.redirectUris`.
The default is ChatGPT's stable callback; discovery advertises issuer
identification, and every authorization redirect includes `iss`. The embedded
resource declares `https://chatgpt.donkeycut.com` as its dedicated widget domain.
ChatGPT uses this identifier to derive an OpenAI-hosted sandbox origin. The
widget HTML arrives through MCP, its scripts and styles load from
`donkeycut.com`, and video loads from `media.donkeycut.com`. This setup requires
no DNS record or Cloudflare Worker for `chatgpt.donkeycut.com`.

Public submission verifies control of the MCP server's host, `donkeycut.com`,
through OpenAI's generated well-known challenge URL. Add the exact token from
the submission portal when that challenge is issued.

Run the client tests with `bun test src/clients/chatgpt`. The browser fixture
`bun run scripts/eval-chatgpt-widget.ts` checks selection, repeated polling,
playback, URL recovery, hidden playback, and teardown against a mock host.
The final deployment check connects a real account in ChatGPT, opens a cloud
project, renders it, and reconnects after revocation. The fixture does not
exercise ChatGPT's account-linking UI or the production database.

## Source entrypoints

- `site/src/clients/chatgpt/server/` — OAuth, MCP tools, and cloud-project adapter.
- `site/src/clients/chatgpt/ui/` — standalone MCP Apps widget and host bridge.
- `site/packages/artifact-player/` — shared website and widget playback.
- `site/src/cut/server/cloud/previewJobs.ts` — revision reuse and document-backed rendering.

The protocol follows OpenAI's [authentication guidance](https://developers.openai.com/apps-sdk/build/auth)
and [MCP Apps UI guidance](https://developers.openai.com/plugins/build/chatgpt-ui).
