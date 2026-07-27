// Wake the render worker's container. Fire-and-forget: a lost wake self-heals
// because the client keeps polling its queued job, and every such poll wakes
// again. The address is a hostname, so it lives in code (lib/hosts.ts) with the
// route that serves it; the shared secret is the only environment input, and
// holding it is the single switch that turns waking on. Unset (local dev), the
// dev worker is run by hand and polls on its own.
import { CUT_WORKER_WAKE_URL } from "@/cut/lib/hosts";

const wakeSecret = () => process.env.CUT_RENDER_WAKE_SECRET;

// A wake that never lands strands every render — the container is not started
// and jobs queue forever — and retrying can't help, because the address itself
// is wrong. Nothing waits on the result, so the log is the only place it can
// show up; swallowing it is what let a dead wake go unnoticed for two days.
export function wakeRenderWorker(): void {
  const secret = wakeSecret();
  if (!secret) return;
  void fetch(CUT_WORKER_WAKE_URL, {
    method: "POST",
    headers: { authorization: `Bearer ${secret}` },
  })
    .then((res) => {
      if (!res.ok) console.error(`[cut] render worker wake refused: HTTP ${res.status}`);
    })
    .catch((e: unknown) => {
      console.error("[cut] render worker wake failed:", e instanceof Error ? e.message : e);
    });
}
