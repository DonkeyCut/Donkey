# Cut cloud render worker

A Linux container that executes Cut web mode's background jobs — `export`,
`preview` (hover proxy), `card` (a shared link's preview image), and
`import_url` — by polling the `cut_render_job`
table and running the same pipeline code the local engine uses
(`../server/exportPipeline.ts`, `../server/urlDownload.ts`). Media moves
through Cloudflare R2; ffmpeg/ffprobe/yt-dlp come from the container image's
PATH.

## Build

```sh
npm run worker:build                                      # bundles to dist/cut-worker/main.js
docker build -f src/cut/worker/Dockerfile -t donkey-cut-worker .   # from site/
```

## Run

```sh
docker run -d \
  -e DATABASE_URL=postgres://… \
  -e R2_ACCOUNT_ID=… \
  -e R2_ACCESS_KEY_ID=… \
  -e R2_SECRET_ACCESS_KEY=… \
  donkey-cut-worker
```

Required env (secrets only — everything else is code constants):

- `DATABASE_URL` — the same Postgres the hosted site uses.
- `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY` — R2 credentials
  for the `donkey-cut` bucket.

One replica is enough to start: it runs up to 2 jobs concurrently (the
engine's cap). Replicas can be added later without coordination — the atomic
row claim keeps them from double-running a job, and SIGTERM requeues whatever
a replica had in flight.

## Deploy (Cloudflare Containers)

The worker ships as a Cloudflare Container: `cf/worker.ts` is the Worker
shell, `wrangler.jsonc` the deployment config (1 instance, 2 vCPU / 4 GiB /
10 GB disk). The container runs on demand, not always-on: the hosted API
POSTs the Worker's `/wake` endpoint (bearer `CUT_WAKE_SECRET`) whenever it
queues a job and again on every poll of a still-queued job, so a lost wake
self-heals; `main.ts` exits after ~60s of empty queue so the container stops
billing. Cold start is a few seconds. The hosted deployment needs
`CUT_RENDER_WAKE_SECRET` in its env to send wakes — without it, queued jobs
wait for a manually run worker. The address is code, not config: the Worker
claims `worker.donkeycut.com` as its own custom domain, named in
`src/cut/lib/hosts.ts`. That is deliberate — the wake used to ride the
workers.dev address, and declaring the media route made wrangler turn
workers.dev off, stranding every render with nothing to see but queued jobs.

GitHub Actions deploys automatically on push to `main` when the worker or the
shared pipeline code changes (`.github/workflows/deploy-cut-worker.yml`).
One-time setup:

1. Cloudflare Workers Paid plan (Containers requires it).
2. A Cloudflare API token with the "Edit Cloudflare Workers" template plus
   Containers permissions → repo secrets `CLOUDFLARE_API_TOKEN` and
   `CLOUDFLARE_ACCOUNT_ID`.
3. After the first deploy, set the Worker's secrets once (from `site/`):
   `npx wrangler secret put DATABASE_URL -c src/cut/worker/wrangler.jsonc`
   and the same for `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`,
   `R2_SECRET_ACCESS_KEY`, and `CUT_WAKE_SECRET` (any long random string).
   Use the Supabase connection-pooler URL for `DATABASE_URL`.
4. On the hosted site (Vercel env): `CUT_RENDER_WAKE_SECRET` = the same random
   string.

Manual deploy from `site/`:

```sh
npm run worker:build && npx wrangler deploy -c src/cut/worker/wrangler.jsonc
```

## Shared media at the edge

The Worker also serves a shared project's media (`cf/media.ts`), on its own
hostname and its own R2 binding — the bucket stays private, so this handler is
the only way in. The hosted API mints a short HMAC token per URL; the Worker
checks it, then serves the object from Cloudflare's cache **keyed on the object
path alone**, with the token dropped. That is what lets the token be short:
every viewer and every re-mint share one cached copy instead of missing per
URL.

Two properties fall out of it. Unsharing takes effect within a token's life
(five minutes) rather than the day a presigned R2 URL would keep working. And
media is served from the edge instead of R2's S3 endpoint, which Cloudflare
does not cache at all.

Range requests are served from the cached object (Cloudflare answers `206` from
a stored `200`); a miss streams the asked-for bytes from R2 and warms the full
object in the background. Objects past Cloudflare's 512 MB cacheable ceiling
stream straight through, uncached.

One-time setup:

1. The zone must be on Cloudflare — the Cache API is a no-op on `workers.dev`,
   so the route has to be a real hostname. `wrangler.jsonc` claims
   `media.donkeycut.com` as a custom domain and wrangler creates the DNS record
   and certificate on deploy; a pre-existing CNAME on that name blocks it. The
   handler matches `CUT_MEDIA_HOST` in `../lib/hosts.ts`, so the two names move
   together.
2. Generate the secret once: `openssl rand -hex 32`.
3. Worker secret: `npx wrangler secret put CUT_MEDIA_SIGNING_SECRET -c
   src/cut/worker/wrangler.jsonc`, pasting that value.
4. On the hosted site (Vercel env): `CUT_MEDIA_SIGNING_SECRET`, the same value.
   Holding it is what switches the feature on.

The two sides must carry the same string — a mismatch fails every request's
signature check. Without the site variable the hosted API presigns R2 exactly
as before, so local dev and an un-migrated deployment both keep working.

## Copy queue

The Worker is also the consumer of the `donkey-cut-copy` Cloudflare Queue:
project copies — a viewer copying a share, or an owner duplicating a cloud
project from the dashboard — enqueue a `CutCopyJob` id, and the consumer
POSTs each id back to the hosted `/api/cut-copy-worker` endpoint one message
at a time (`max_batch_size` and `max_concurrency` are both 1), so copies
drain serially instead of stampeding R2. One-time setup:

1. Create the queue (from `site/`): `npx wrangler queues create donkey-cut-copy`.
2. Worker secrets: `CUT_COPY_EXECUTE_URL` (the hosted endpoint, e.g.
   `https://donkeycut.com/api/cut-copy-worker`) and `CUT_COPY_EXECUTE_SECRET`
   (any long random string).
3. On the hosted site (Vercel env): `CLOUDFLARE_QUEUES_API_TOKEN` (an API
   token with Queues edit on the account — publishes ride the REST API since
   the site isn't a Worker) and the same `CUT_COPY_EXECUTE_SECRET`.

Without the queue env, the hosted API runs copies inline in the request —
fine for local dev, unthrottled in production.
