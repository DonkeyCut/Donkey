// Cloudflare Workers shell for the Cut render worker container. Wrangler
// deploys this Worker together with the container image (../Dockerfile). The
// container wakes on demand: the hosted API POSTs /wake whenever it queues a
// job (and while polling a still-queued one, so a lost wake self-heals); the
// poller in ../main.ts exits once the queue drains, stopping the container.
// This file is compiled by wrangler, not the site's tsconfig — workers
// globals are typed loosely on purpose.
import { Container, getContainer } from "@cloudflare/containers";

type WorkerEnv = {
  CUT_RENDER_WORKER: unknown;
  DATABASE_URL: string;
  R2_ACCOUNT_ID: string;
  R2_ACCESS_KEY_ID: string;
  R2_SECRET_ACCESS_KEY: string;
  CUT_WAKE_SECRET: string;
  CUT_COPY_EXECUTE_URL: string;
  CUT_COPY_EXECUTE_SECRET: string;
};

// Minimal shapes for the queue consumer — this file stays off workers-types
// on purpose (see the header note).
type QueueMessage = {
  body: unknown;
  ack(): void;
  retry(opts?: { delaySeconds?: number }): void;
};
type QueueBatch = { messages: QueueMessage[] };

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
    };
  }
}

export default {
  async fetch(request: Request, env: WorkerEnv): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "POST" && url.pathname === "/wake") {
      // Starting the container bills CPU, so the wake is not public: callers
      // present the shared secret the hosted API holds.
      const auth = request.headers.get("authorization") ?? "";
      if (!env.CUT_WAKE_SECRET || auth !== `Bearer ${env.CUT_WAKE_SECRET}`) {
        return new Response("Unauthorized", { status: 401 });
      }
      // start() is a no-op while the container runs and a boot after a sleep.
      await getContainer(env.CUT_RENDER_WORKER as never).start();
      return Response.json({ ok: true });
    }
    return new Response("donkey-cut-worker", { status: 200 });
  },

  // Share-copy queue consumer (donkey-cut-copy, wrangler.jsonc): one message
  // per batch, one batch at a time, so copies drain serially no matter how
  // many viewers ask at once. The copy itself runs on the hosted API — this
  // handler only paces it and carries the queue's retry semantics: 2xx acks,
  // anything else redelivers after a delay.
  async queue(batch: QueueBatch, env: WorkerEnv): Promise<void> {
    for (const message of batch.messages) {
      const jobId = (message.body as { jobId?: unknown } | null)?.jobId;
      if (typeof jobId !== "string" || !jobId) {
        message.ack();
        continue;
      }
      try {
        const res = await fetch(env.CUT_COPY_EXECUTE_URL, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${env.CUT_COPY_EXECUTE_SECRET}`,
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
