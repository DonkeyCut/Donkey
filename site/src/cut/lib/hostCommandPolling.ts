import type { Settings } from "@/lib/config/registry";
import type { CommandJobSpec } from "@/cut/lib/commandBatch";

type Claimed = { id: string; spec: CommandJobSpec };

/** Each completed poll returns its next delay; an expired session stops it. */
export function hostCommandPoller(options: {
  claim: () => Promise<Response>;
  run: (job: Claimed) => Promise<void>;
  settings: () => Settings["chatgptPolling"];
  hidden: () => boolean;
}) {
  let backoff = 0;
  return async (): Promise<number | null> => {
    const settings = options.settings();
    const cadence = options.hidden() ? settings.hiddenPollMs : settings.pollMs;
    let retryAfter = 0;
    try {
      const response = await options.claim();
      if ([401, 403, 404].includes(response.status)) return null;
      if (response.status === 200 || response.status === 204) {
        if (response.status === 200) await options.run(await response.json() as Claimed);
        backoff = 0;
        return response.status === 200 ? 0 : cadence;
      }
      const retry = response.headers.get("retry-after");
      if (retry) {
        const seconds = Number(retry);
        retryAfter = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(retry) - Date.now();
        if (!Number.isFinite(retryAfter)) retryAfter = 0;
      }
    } catch {
      // Network failures use the same bounded cadence as server failures.
    }
    backoff = Math.min(settings.maxBackoffMs, Math.max(cadence, backoff) * 2);
    return Math.max(backoff, retryAfter);
  };
}
