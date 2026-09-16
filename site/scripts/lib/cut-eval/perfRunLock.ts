import { createServer, type Server } from "node:net";

/** One performance run per machine. The OS releases the lock on process exit. */
export async function lockPerfRun(port = 43199): Promise<Server> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", (error: NodeJS.ErrnoException) => {
      reject(error.code === "EADDRINUSE"
        ? new Error(`Another performance run is active or local port ${port} is occupied. Wait for it to finish before running the eval.`)
        : error);
    });
    server.listen(port, "127.0.0.1", resolve);
  });
  server.unref();
  return server;
}
