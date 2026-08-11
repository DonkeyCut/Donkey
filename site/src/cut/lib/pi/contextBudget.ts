import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { Message, UserMessage } from "@earendil-works/pi-ai";
import type { DonkeyToolDetails, WireCarrier, WirePart } from "./donkeyStream";

// A chat turn replays its whole session on every model call, and media —
// listen_audio sound, watch_video contact sheets, attachment payloads — rides
// that context inline. The hosted route refuses any request whose media tops
// its per-request cap, so a long editing pass would grow call over call until
// every remaining call is refused. Trimming to this budget before each call
// makes that impossible by construction: media parts leave oldest-first, one
// part at a time, until the rest fits — a message keeps whatever of its media
// still fits — with a note saying how to fetch the dropped ones again. Text,
// tool calls, tool results, and thought signatures all survive; only raw
// pixels and sound the model already took in are released. The trim is
// applied to a copy — the stored session keeps its media, and every call
// re-trims deterministically.

export const MEDIA_BUDGET_BYTES = 16 * 1024 * 1024;

const b64Bytes = (data: string): number => Math.floor(data.length * 0.75);

const partBytes = (part: WirePart): number =>
  typeof part.dataBase64 === "string" ? b64Bytes(part.dataBase64) : 0;

const droppedNote = (count: number): string =>
  `[${count === 1 ? "A media attachment" : `${count} media attachments`} in this step ${
    count === 1 ? "was" : "were"
  } dropped to keep this request under the media size limit. Fetch what you still need with the media tools (listen_audio, watch_video, capture_frame), a narrower range at a time.]`;

const messageBytes = (m: AgentMessage): number => {
  const msg = m as Message;
  if (msg.role === "user") {
    let bytes = 0;
    for (const p of (msg as WireCarrier).wireParts ?? []) bytes += partBytes(p);
    if (Array.isArray(msg.content)) {
      for (const c of msg.content) if (c.type === "image") bytes += b64Bytes(c.data);
    }
    return bytes;
  }
  if (msg.role === "toolResult") {
    let bytes = 0;
    const details = msg.details as DonkeyToolDetails | undefined;
    for (const p of details?.mediaParts ?? []) bytes += partBytes(p);
    return bytes;
  }
  return 0;
};

/** Messages with their inline media trimmed to `budget`, oldest parts first;
 * a part stays once the total fits. The input array and its messages are
 * never mutated. */
export function enforceContextBudget(
  messages: AgentMessage[],
  budget = MEDIA_BUDGET_BYTES
): AgentMessage[] {
  const sizes = messages.map(messageBytes);
  let total = 0;
  for (const s of sizes) total += s;
  if (total <= budget) return messages;
  // In message order (oldest first), each media part is dropped while the
  // total still tops the budget and kept once it fits.
  const keep = (bytes: number): boolean => {
    if (bytes === 0 || total <= budget) return true;
    total -= bytes;
    return false;
  };
  return messages.map((m, i) => {
    if (sizes[i] === 0 || total <= budget) return m;
    const msg = m as Message;
    if (msg.role === "user") {
      const u = msg as UserMessage & WireCarrier;
      let dropped = 0;
      const keptContent = Array.isArray(u.content)
        ? u.content.filter((c) => {
            if (c.type !== "image" || keep(b64Bytes(c.data))) return true;
            dropped++;
            return false;
          })
        : [{ type: "text" as const, text: u.content }];
      const keptWire = (u.wireParts ?? []).filter((p) => {
        if (keep(partBytes(p))) return true;
        dropped++;
        return false;
      });
      if (dropped === 0) return m;
      return {
        ...u,
        content: [...keptContent, { type: "text" as const, text: droppedNote(dropped) }],
        wireParts: keptWire,
      };
    }
    // toolResult (assistant messages carry no media by construction)
    const t = msg as Extract<Message, { role: "toolResult" }>;
    const details = t.details as DonkeyToolDetails;
    let dropped = 0;
    const keptMedia = (details.mediaParts ?? []).filter((p) => {
      if (keep(partBytes(p))) return true;
      dropped++;
      return false;
    });
    if (dropped === 0) return m;
    return {
      ...t,
      details: { ...details, mediaParts: [...keptMedia, { text: droppedNote(dropped) }] },
    };
  });
}
