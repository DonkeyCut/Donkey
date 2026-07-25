# Cut cloud render worker

A Linux container that executes Cut web mode's background jobs — `export`,
`preview` (hover proxy), and `import_url` — by polling the `cut_render_job`
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
`CUT_RENDER_WAKE_URL` (the Worker's `/wake` URL) and `CUT_RENDER_WAKE_SECRET`
in its env to send wakes — without them, queued jobs wait for a manually run
worker.

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
4. On the hosted site (Vercel env): `CUT_RENDER_WAKE_URL` = the deployed
   Worker's URL + `/wake` (e.g.
   `https://donkey-cut-worker.<subdomain>.workers.dev/wake`) and
   `CUT_RENDER_WAKE_SECRET` = the same random string.

Manual deploy from `site/`:

```sh
npm run worker:build && npx wrangler deploy -c src/cut/worker/wrangler.jsonc
```

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
