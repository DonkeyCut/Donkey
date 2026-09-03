// Cloudflare Workers shell for the Cut render worker container. Wrangler
// deploys this Worker together with the container image (../Dockerfile). The
// container wakes on demand: the hosted API POSTs /wake whenever it queues a
// job (and while polling a still-queued one, so a lost wake self-heals); the
// poller in ../main.ts exits once the queue drains, stopping the container.
// This file is compiled by wrangler, not the site's tsconfig — workers
// globals are typed loosely on purpose.
import { Container, getContainer } from "@cloudflare/containers";
import { CUT_MEDIA_HOST, CUT_WORKER_HOST } from "../../lib/hosts";
import { serveMedia, type MediaEnv } from "./media";
import { MAX_REPLICAS, replicasToStart, type WakeBody } from "./wakeSize";

type WorkerEnv = MediaEnv & {
  CUT_RENDER_WORKER: unknown;
  DATABASE_URL: string;
  R2_ACCOUNT_ID: string;
  R2_ACCESS_KEY_ID: string;
  R2_SECRET_ACCESS_KEY: string;
  CUT_WAKE_SECRET: string;
  CUT_COPY_EXECUTE_URL: string;
  CUT_COPY_EXECUTE_SECRET: string;
  JOBS_EXECUTE_URL: string;
  JOBS_EXECUTE_SECRET: string;
  CLOUDFLARE_KV_API_TOKEN: string;
};

// Minimal shapes for the queue consumer — this file stays off workers-types
// on purpose (see the header note).
type QueueMessage = {
  body: unknown;
  ack(): void;
  retry(opts?: { delaySeconds?: number }): void;
};
type QueueBatch = { queue: string; messages: QueueMessage[] };

// The most container replicas the render pool runs. Each one takes a single
// job at a time, so this is also the number of renders that can be in flight
// at once. Keep it in step with max_instances in ../wrangler.jsonc. A wake
// starts only as many as the queue needs (wakeSize.ts): a replica bills
// its whole 12 GiB for every second it is up, idle polling included, so one
// started with nothing to claim is a minute of paid memory for no render.
const REPLICAS = MAX_REPLICAS;

const replicaName = (i: number) => `cut-render-${i}`;

export class CutRenderWorker extends Container<WorkerEnv> {
  // Backstop only: main.ts exits by itself when the queue drains. This stops
  // a hung process that no longer polls (and so can't exit).
  sleepAfter = "15m";

  constructor(ctx: unknown, env: WorkerEnv) {
    // The Container base types come from workers-types, which this file keeps
    // out of the site program; the runtime shapes match.
    super(ctx as never, env as never);
    this.envVars = {
      DATABASE_URL: env.DATABASE_URL,
      R2_ACCOUNT_ID: env.R2_ACCOUNT_ID,
      R2_ACCESS_KEY_ID: env.R2_ACCESS_KEY_ID,
      R2_SECRET_ACCESS_KEY: env.R2_SECRET_ACCESS_KEY,
      // The container records a finished HLS ladder in KV. It is not a Worker,
      // so it has no binding and goes over the REST API like the site does.
      CLOUDFLARE_KV_API_TOKEN: env.CLOUDFLARE_KV_API_TOKEN,
    };
  }
}

export default {
  async fetch(
    request: Request,
    env: WorkerEnv,
    ctx: { waitUntil(p: Promise<unknown>): void }
  ): Promise<Response> {
    const url = new URL(request.url);
    // Two hostnames, two jobs (both claimed in wrangler.jsonc): media is the
    // only public traffic this Worker takes, and the control plane is where the
    // hosted API wakes the container. The control host is matched first — the
    // media branch returns, so a /wake arriving there would be swallowed.
    if (url.hostname !== CUT_WORKER_HOST && url.hostname === CUT_MEDIA_HOST) {
      return serveMedia(request, env, ctx);
    }
    if (request.method === "POST" && url.pathname === "/wake") {
      // Starting the container bills CPU, so the wake is not public: callers
      // present the shared secret the hosted API holds.
      const auth = request.headers.get("authorization") ?? "";
      if (!env.CUT_WAKE_SECRET || auth !== `Bearer ${env.CUT_WAKE_SECRET}`) {
        return new Response("Unauthorized", { status: 401 });
      }
      // Start as many replicas as the queue needs, lowest index first. Each
      // claim is atomic, so a burst of jobs still renders in parallel, one per
      // replica; start() is a no-op on a replica already running and a boot
      // on one that slept.
      const body = (await request.json().catch(() => null)) as WakeBody | null;
      const wanted = replicasToStart(body);
      const starts = await Promise.allSettled(
        Array.from({ length: wanted }, (_, i) =>
          getContainer(env.CUT_RENDER_WORKER as never, replicaName(i)).start()
        )
      );
      const started = starts.filter((s) => s.status === "fulfilled").length;
      // Some replicas failing still drains the queue, just slower. All of them
      // failing means no render can ever run, which has to be loud.
      if (started === 0) {
        const first = starts.find((s) => s.status === "rejected");
        const why = first?.status === "rejected" ? String(first.reason) : "unknown";
        return new Response(`No render replica started: ${why}`, { status: 500 });
      }
      return Response.json({ ok: true, started });
    }
    return new Response("donkey-cut-worker", { status: 200 });
  },

  // Queue consumer for both queues in wrangler.jsonc — share copies
  // (donkey-cut-copy) and the site's generic async jobs (donkey-jobs). Each
  // drains serially: one message per batch, one batch at a time. The work
  // itself runs on the hosted API — this handler only paces it and carries the
  // queue's retry semantics: 2xx acks, anything else redelivers after a delay.
  async queue(batch: QueueBatch, env: WorkerEnv): Promise<void> {
    const target =
      batch.queue === "donkey-jobs"
        ? { url: env.JOBS_EXECUTE_URL, secret: env.JOBS_EXECUTE_SECRET }
        : { url: env.CUT_COPY_EXECUTE_URL, secret: env.CUT_COPY_EXECUTE_SECRET };
    for (const message of batch.messages) {
      const jobId = (message.body as { jobId?: unknown } | null)?.jobId;
      if (typeof jobId !== "string" || !jobId) {
        message.ack();
        continue;
      }
      try {
        const res = await fetch(target.url, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${target.secret}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ jobId }),
        });
        if (res.ok) message.ack();
        else message.retry({ delaySeconds: 30 });
      } catch {
        message.retry({ delaySeconds: 30 });
      }
    }
  },
};
