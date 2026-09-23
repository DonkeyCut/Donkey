# ChatGPT App

The ChatGPT app connects a Donkey Cut account and lets ChatGPT edit its cloud
projects: import footage, inspect it, cut it, caption it, preview, undo, and
export, with the preview and the export download playing inside the
conversation. ChatGPT is the model; Donkey Cut checks ownership and runs the
typed commands it sends.

**The one rule:** the ChatGPT adapter lives under `site/src/clients/chatgpt`.
Editing, rendering and playback stay in Cut; the adapter only translates.

```text
ChatGPT tools and embedded card
              ↓
Scoped OAuth connection
              ↓
Cloud project, command and render services
              ↓
Command batch → the editor in the card runs it → versioned save
Captured document → worker renderer → signed media
```

## Editing from ChatGPT

ChatGPT reads the editor's tool catalog and sends a batch through `edit_project`; the editor open in the card claims it, runs it on the document the user is looking at as one undo step, saves, and reports the result. Nothing else runs a batch: with no card open the tool answers that the project has to be opened first, and undo and redo step the card's own history, which the user's edits share. Editing, previews and exports
spend no credits; commands that generate media spend the account's credits, and
imports and exports use its storage allowance. The server's instructions and
tool descriptions say so, with the repository linked, so ChatGPT explains the
economics before it acts.

## Client boundaries

The standalone widget imports `@donkeycut/artifact-player/ArtifactVideo`, the
same player used by website previews and shared videos. The package owns video
buffers, visibility handling, and teardown. HLS loads on demand. The widget is
built by `npm run chatgpt:build`, which also runs before the site's development
and production builds. Rebuild it after editing widget code. ChatGPT caches the
widget HTML it reads over MCP, so the entry script and stylesheet keep stable
names that revalidate on every load; only the chunks they import are hashed.

The MCP adapter exposes project listing, creation and opening, the command
catalog and guides, editing, importing, undo and redo, previews, exports and job
polling. Its schemas and widget data types share one contract. Signed media and
download URLs travel in tool-result metadata, which reaches the widget. The
model gets project metadata, command outcomes, render state, and an Open in
Donkey Cut link. ChatGPT's sandbox drops null-valued keys from a tool result
before the widget sees it, so the widget contract treats a missing key and null
alike.

Opening a project plays the proxy the editor already rendered for it, the
same file the share page serves, so nobody waits on a render to watch. A
render is for a revision with no current proxy, such as one edited from
ChatGPT; it uses the existing headless renderer and a captured document, and
repeated requests for the same saved revision reuse a queued, running, or
available completed preview. A collected preview can be rendered again.
Browser and Mac projects retain their existing render paths; they become
accessible to ChatGPT after the user saves them to the cloud in Donkey Cut.

The widget polls while visible and renews expiring playback URLs through the
host bridge. It has no account cookie or OAuth token. Preview rendering uses
no Donkey Cut AI credits. Derived previews remain exempt from storage quota;
retained media uses the account's existing storage allowance.

Every project card from a connection that can edit is the whole editor. The
widget frames `donkeycut.com` through a one-use, one-minute link minted with
each tool result; a card that wakes with a spent link asks for another. The
link redeems for a partitioned session cookie, signing the editor in inside
the frame until the connection is revoked; without partitioned cookies the
frame offers an Open in Donkey Cut link. The editor's skeleton covers the
frame until the frame reports something to show. `frameDomains` is justified
as the app's own editor on its own domain.

## Account linking

Donkey Cut supplies the account identity to ChatGPT through OpenID Connect.
The user signs in and consents to project access and identity sharing. The
`openid` and `email` scopes expose the account ID, email, and stored verification
status through `/api/chatgpt/oauth/userinfo`. Unverified accounts can connect;
profile settings offer email verification.

Discovery lives at `/.well-known/openid-configuration` and
`/.well-known/oauth-authorization-server`. Configure `CHATGPT_OIDC_PRIVATE_KEY`
with a PKCS#8 RSA private key of at least 2048 bits before deploying. Code
exchange signs an ID token bound to the client and requested nonce; the public
key is served at `/api/chatgpt/oauth/jwks`.

Consent binds the browser, account, callback, scopes, resource, and S256 challenge.
Codes are single use, refresh tokens rotate, and replay revokes the connection.
Tokens are hashed in storage. MCP and UserInfo check expiration, revocation,
resource, and scopes on every request. Source and account rate limits apply;
daily cleanup removes expired grants, tokens, and challenges. Revocation leaves
already issued media links valid until their normal expiry.

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
`https://donkeycut.com/api/chatgpt/mcp`. Upload `site/public/chatgpt-app-icon.png`
as the app icon. Use the predefined public OAuth client
ID `donkey-chatgpt`, no client secret, and scopes
`projects:read previews:render projects:write openid email`. The listing
should describe supported editing and disclose generation credits and storage
limits.
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
playback, URL recovery, hidden playback, the editor frame, and teardown
against a mock host. With
the dev server and a local worker up, `bun run scripts/eval-chatgpt-workflow.ts`
drives the whole editing workflow through the MCP tools in process: create,
import, inspect, edit, preview, undo, redo, export.
The final deployment check connects a real account in ChatGPT, opens a cloud
project, renders it, and reconnects after revocation. The fixture does not
exercise ChatGPT's account-linking UI or the production database.

## Source entrypoints

- `site/src/clients/chatgpt/server/` — OAuth, MCP tools, the command catalog, and the cloud-project adapter.
- `site/src/clients/chatgpt/ui/` — standalone MCP Apps widget and host bridge.
- `site/packages/artifact-player/` — shared website and widget playback.
- `site/src/cut/server/cloud/commands.ts` and `site/src/cut/lib/hostCommands.ts` — the command job, and the editor in the card running it.
- `site/src/cut/server/cloud/previewJobs.ts` — revision reuse and document-backed rendering.

The protocol follows OpenAI's [authentication guidance](https://developers.openai.com/apps-sdk/build/auth)
and [MCP Apps UI guidance](https://developers.openai.com/plugins/build/chatgpt-ui).
