// A chat turn replays its whole conversation on every tool round, and media —
// listen_audio sound, watch_video contact sheets, attachment payloads — rides
// that input inline. The hosted route refuses any request whose media tops its
// per-request cap (lib/inference/blobs.ts), so on a large project a long
// editing pass would grow round over round until every remaining round is
// refused. Trimming the input to this budget before each round makes that
// impossible by construction: the oldest media leaves first, replaced by a note
// saying how to fetch it again, and the request always fits no matter how many
// rounds the turn runs or how large the project is. The model keeps everything
// it concluded — text, tool calls, and tool results all survive; only the raw
// pixels and sound it already took in are released.

type Item = Record<string, unknown>;

// Sized under the route's 20MB resolved-media cap, with headroom for the
// counting difference: this counts every media part, the route counts only the
// offloaded ones, so a request trimmed here always clears the route.
export const MEDIA_BUDGET_BYTES = 16 * 1024 * 1024;

/** Raw bytes behind one content part's inline media. Chat media parts carry
 * base64 under `dataBase64` (refsToParts, functionResponseParts). */
const mediaBytes = (part: Item): number =>
  typeof part.dataBase64 === "string" ? Math.floor(part.dataBase64.length * 0.75) : 0;

const droppedNote = (count: number): Item => ({
  text: `[${count === 1 ? "A media attachment" : `${count} media attachments`} in this step ${
    count === 1 ? "was" : "were"
  } dropped to keep this request under the media size limit. Fetch what you still need with the media tools (listen_audio, watch_video, capture_frame), a narrower range at a time.]`,
});

/**
 * Trim `input` in place until its inline media fits `budget`. Media parts are
 * dropped oldest-first — input order is arrival order, so what leaves is what
 * the model has had longest — and each trimmed step gains one note naming what
 * left and how to get it back. Text parts, function calls and responses, and
 * thought signatures all stay.
 */
export function enforceMediaBudget(input: Item[], budget = MEDIA_BUDGET_BYTES): void {
  let total = 0;
  for (const item of input) {
    const content = item.content;
    if (!Array.isArray(content)) continue;
    for (const part of content) total += mediaBytes(part as Item);
  }
  for (const item of input) {
    if (total <= budget) return;
    const content = item.content;
    if (!Array.isArray(content)) continue;
    let dropped = 0;
    const kept: Item[] = [];
    for (const part of content as Item[]) {
      const bytes = mediaBytes(part);
      if (bytes > 0 && total > budget) {
        total -= bytes;
        dropped += 1;
        continue;
      }
      kept.push(part);
    }
    if (dropped > 0) {
      kept.push(droppedNote(dropped));
      item.content = kept;
    }
  }
}
