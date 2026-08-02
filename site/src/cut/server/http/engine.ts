import os from "node:os";

/** The engine's version: the Donkey app passes its own release version when it
 * spawns the engine, so engine updates ride app updates. "dev" everywhere
 * else (Next dev server, a hand-run engine). */
const engineVersion = () => process.env.DONKEY_CUT_VERSION ?? "dev";

/** The macOS account this engine runs as. The app's supervisor compares it to
 * its own user so it never signals — or adopts — an engine another user owns. */
const engineUser = () => {
  try {
    return os.userInfo().username;
  } catch {
    return null;
  }
};

export const engineApi = {
  /** Probed by the client to find the engine; version feeds the update nudge. */
  async health() {
    return Response.json({
      ok: true,
      engine: "donkey-cut",
      version: engineVersion(),
      user: engineUser(),
    });
  },
};
