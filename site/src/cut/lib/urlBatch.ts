/**
 * Importing a list of URLs at once — the footage of a whole section of a
 * template, say — a few downloads at a time, each answer on its own row in
 * the order asked so a failed link never sinks the rest.
 */

/** The most URLs one batch takes. */
export const URL_BATCH_MAX = 24;

/** How many downloads the local server runs at once (`urlImport.ts` turns
 * the next one away as busy), so a batch never runs more lanes than this. */
export const URL_DOWNLOADS_MAX = 2;

/** What the local server answers when every download slot is taken. */
export const URL_BUSY_MESSAGE = "Too many downloads in progress. Try again in a moment.";

/** How long a batch works before it answers: inside the chat bridge's two
 * minutes a tool call gets (`server/ai/bridge.ts`), with room to describe
 * what landed. A long list answers in parts — the chat calls again with what
 * never started. */
export const URL_BATCH_BUDGET_MS = 90_000;

/** How long a link turned away as busy waits before it asks again: a slot
 * frees when any download ends. */
const BUSY_WAIT_MS = 1500;

/** One URL's answer: what it brought in, why it failed, still downloading
 * when the batch answered (it lands in the project on its own), or never
 * started (ask for it again). */
export type UrlRow<T> =
  | { url: string; value: T }
  | { url: string; error: string }
  | { url: string; pending: true }
  | { url: string; notStarted: true };

const messageOf = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** Thrown inside a lane when the budget runs out while a link waits for a
 * slot: it never started. */
const OUT_OF_TIME = Symbol("out of time");

export async function importEach<T>(
  urls: string[],
  importOne: (url: string) => Promise<T>,
  opts: { busyWaitMs?: number; budgetMs?: number } = {}
): Promise<UrlRow<T>[]> {
  const list = [...new Set(urls.map((u) => u.trim()).filter(Boolean))];
  if (list.length > URL_BATCH_MAX) throw new Error(`At most ${URL_BATCH_MAX} URLs per call.`);
  const wait = opts.busyWaitMs ?? BUSY_WAIT_MS;
  const deadline = Date.now() + (opts.budgetMs ?? URL_BATCH_BUDGET_MS);
  const rows: (UrlRow<T> | undefined)[] = new Array(list.length);
  let answered = false;
  // A link turned away as busy (a download started elsewhere holds a slot)
  // waits and asks again, until the budget runs out. One whose ask was in
  // flight when the batch answered was reported as still downloading, so it
  // keeps asking until it starts and lands on its own.
  const attempt = async (url: string): Promise<T> => {
    for (;;) {
      try {
        return await importOne(url);
      } catch (e) {
        if (messageOf(e) !== URL_BUSY_MESSAGE) throw e;
        if (!answered && Date.now() + wait >= deadline) throw OUT_OF_TIME;
        await new Promise((r) => setTimeout(r, wait));
      }
    }
  };
  let next = 0;
  const lane = async () => {
    while (next < list.length && Date.now() < deadline) {
      const i = next++;
      const url = list[i];
      try {
        rows[i] = { url, value: await attempt(url) };
      } catch (e) {
        rows[i] = e === OUT_OF_TIME ? { url, notStarted: true } : { url, error: messageOf(e) };
      }
    }
  };
  const lanes = Promise.all(Array.from({ length: Math.min(URL_DOWNLOADS_MAX, list.length) }, lane));
  let timer: ReturnType<typeof setTimeout> | undefined;
  const outOfTime = new Promise<void>((r) => (timer = setTimeout(r, Math.max(0, deadline - Date.now()))));
  await Promise.race([lanes, outOfTime]);
  clearTimeout(timer);
  answered = true;
  // A link a lane took up is still downloading; one no lane reached never
  // started.
  return list.map((url, i) => rows[i] ?? (i < next ? { url, pending: true as const } : { url, notStarted: true as const }));
}
