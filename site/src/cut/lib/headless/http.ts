/**
 * Calls a headless run makes to the hosted site, made to survive the network.
 *
 * A worker container reaches the site over the open internet, and a single
 * dropped connection there is a whole render lost: `fetch` rejects with a bare
 * "fetch failed" and the job row wears that as its reason, which tells whoever
 * asked for the export nothing about what happened or whether asking again
 * would work. So the transient failures — a refused connection, a reset, a
 * gateway that is briefly out — are retried here, and what finally reaches the
 * job says which call gave up.
 */

/** Attempts, including the first. */
const ATTEMPTS = 4;
const BACKOFF_BASE_MS = 500;

/** Statuses worth asking again about: the service is up, this instance isn't. */
const RETRY_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);

/** Methods a second attempt is safe on: asking twice reads the same thing. */
const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * `fetch`, retried on the failures that pass. `what` names the call in the
 * error a caller finally sees ("read the project", "sign the media URLs").
 *
 * Only a call that can be made twice is made twice. A write cannot: a gateway
 * that drops the connection after the write commits leaves the caller unable
 * to tell a lost request from a landed one, and resending a versioned PUT
 * whose first attempt landed comes back 409 — a save reported as a concurrent
 * writer. A call that writes nothing says so with `retry`.
 */
export async function fetchWithRetry(
  url: string,
  init: RequestInit,
  what: string,
  opts: { retry?: boolean } = {}
): Promise<Response> {
  const attempts =
    (opts.retry ?? SAFE_METHODS.has((init.method ?? "GET").toUpperCase())) ? ATTEMPTS : 1;
  let last: unknown;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const res = await fetch(url, init);
      if (!RETRY_STATUS.has(res.status) || attempt === attempts) return res;
      last = new Error(`${res.status}`);
    } catch (err) {
      // An abort is the caller's own decision; nothing to retry.
      if ((err as { name?: string }).name === "AbortError") throw err;
      last = err;
      if (attempt === attempts) break;
    }
    await wait(BACKOFF_BASE_MS * 2 ** (attempt - 1));
  }
  const detail = last instanceof Error ? last.message : String(last);
  throw new Error(`Could not ${what} — the service did not answer (${detail}).`);
}
