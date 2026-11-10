// Local dev has no container to wake, so the dev server runs the render worker
// itself: the same bundle the container runs, under node (the R2 client's
// streams break under bun), with the dev server's env. The worker exits after
// a minute of empty queue, exactly as in the container, and the next wake
// starts a fresh build of it — so a worker edit lands on the next job.
import { spawn, type ChildProcess } from "node:child_process";

// Bundle first so the run picks up current source; `exec` hands the shell's
// pid to node, so stopping the child stops the worker.
const DEV_WORKER_COMMAND = "npm run --silent worker:build && exec node dist/cut-worker/main.js";

// Next reloads server modules on edit; the handle lives on globalThis so a
// reload doesn't start a second worker beside the running one.
const holder = globalThis as { cutDevWorker?: ChildProcess };

/** Start the dev worker unless one this server started is still running. */
export function startDevWorker(): void {
  if (holder.cutDevWorker) {
    return;
  }

  // Inherit stdio so the worker's job log reads in the dev server's terminal.
  const child = spawn("sh", ["-c", DEV_WORKER_COMMAND], { cwd: process.cwd(), env: process.env, stdio: "inherit" });
  holder.cutDevWorker = child;
  const forget = () => {
    if (holder.cutDevWorker === child) {
      holder.cutDevWorker = undefined;
    }
  };
  child.on("exit", forget);
  child.on("error", (e) => {
    console.error("[cut] dev render worker failed to start:", e.message);
    forget();
  });
}
