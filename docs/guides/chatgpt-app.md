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
Cloud project, command, history and render services
              ↓
Command batch → worker runs the editor's own tools → versioned save + checkpoint
Captured document → worker renderer → signed media
```

## Editing from ChatGPT

ChatGPT reads the editor's tool catalog through `list_commands` and
`describe_commands`, then sends a batch through `edit_project`. The batch runs as
a job in the worker container: the project document opens into the editor store,
each command runs through the same executor the chat assistant uses, the
document saves through the versioned PUT, and the whole batch becomes one
checkpoint in the project's undo history. `inspect_project` runs the same way
without saving, so contact sheets and captured frames come back as images.
Imports are the existing URL-import job with adoption turned on, so footage the
user attaches in ChatGPT or links to lands as project assets; exports are the
document export the phone uses, with the download offered on the card.

Undo and redo walk the checkpoint line, which is anchored to the project's
version: a save from the editor moves the version off the line, so ChatGPT
never reverts an edit the user made in the app. Editing, previews and exports
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

Opening a project from a connection that can edit puts the whole editor in
the card: the widget frames `donkeycut.com` through a one-use, one-minute
link the tool mints on the connection, and that link redeems for a
partitioned session cookie scoped to the frame, so the editor is signed in
there and nowhere else. Revoking the
connection ends those sessions. A browser without partitioned cookies shows
an Open in Donkey Cut link inside the frame. Public submission has to justify
`frameDomains`; the justification is that the frame is the app's own editor
on its own domain.

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
| `/api/chatgpt/mcp` | Stateless MCP over HTTP POST, serving protocol 2026-07-28 requests directly and older initialize-based clients the same way |
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
`https://donkeycut.com/api/chatgpt/mcp`. Upload `site/public/chatgpt-app-icon.png`
as the app icon: 256×256, under 10 KB, a full-bleed white square with square
corners, because ChatGPT applies its own rounded mask, and the mark inside a
safe area so the mask never clips it. Use the predefined public OAuth client
ID `donkey-chatgpt`, no client secret, and scopes
`projects:read previews:render projects:write`. The app listing's description
should say what the server instructions say: Donkey Cut is an open-source video
editor (Apache 2.0, github.com/DonkeyCut/Donkey) that ChatGPT can edit with
directly; editing, previews and exports are free, hosted AI generation spends
credits, and cloud storage counts against the account's allowance.
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
- `site/src/cut/server/cloud/commands.ts` and `history.ts` — the command job and the checkpoint history.
- `site/src/cut/worker/commandJob.ts` — the batch runner and import adoption in the container.
- `site/src/cut/server/cloud/previewJobs.ts` — revision reuse and document-backed rendering.

The protocol follows OpenAI's [authentication guidance](https://developers.openai.com/apps-sdk/build/auth)
and [MCP Apps UI guidance](https://developers.openai.com/plugins/build/chatgpt-ui).
