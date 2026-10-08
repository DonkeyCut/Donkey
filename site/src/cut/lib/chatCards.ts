import type { UIMessage } from "ai";
import { normalizeRef } from "./assetRef";

// Tool outputs name the media a call made with `assetId`; the chat renders a
// card for each. An import of something the user attached (a stock sound, a
// Library clip) also says which ref it came from (`fromRef`), and the user's
// own attachment card already shows it, so the import gets no second card.

const KEY_SEP = "\n";

const refKey = (scope: string, id: string) => `${scope}:${id}`;

/** Every ref the user attached anywhere in the thread, as one string of
 * `scope:id` keys — a string so memoized message views compare it by value. */
export function attachedRefKeys(messages: readonly UIMessage[]): string {
  const keys = new Set<string>();
  for (const m of messages) {
    if (m.role !== "user") {
      continue;
    }
    const raw = (m.metadata as { attachments?: unknown[] } | undefined)?.attachments ?? [];
    for (const r of raw.map(normalizeRef)) {
      if (r) {
        keys.add(refKey(r.scope, r.id));
      }
    }
  }
  return [...keys].sort().join(KEY_SEP);
}

/** Whether a tool output imported a ref the user attached in the thread. */
export function cardIsAttached(output: unknown, attached: string): boolean {
  if (!output || typeof output !== "object" || !attached) {
    return false;
  }
  const from = (output as { fromRef?: { scope?: unknown; id?: unknown } }).fromRef;
  if (typeof from?.scope !== "string" || typeof from.id !== "string") {
    return false;
  }
  return attached.split(KEY_SEP).includes(refKey(from.scope, from.id));
}
