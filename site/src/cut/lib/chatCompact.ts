// The cloud copy of a chat thread has to fit one request: the server refuses a
// thread past 4,000,000 characters (and Vercel any body past 4.5 MB). The
// browser keeps the whole thread; what goes up is this compacted copy, so a
// long chat's history always reaches the account instead of failing the save.
//
// In order, until it fits: inline media still in the thread (a listen_audio
// clip, any data URL the storage slim didn't know) gives way to a note; then
// the bulkiest tool results, oldest first, across the transcript and the pi
// context, keep only a preview; then the pi context goes (the browser still
// holds it); last, the oldest messages. Every call's id, state and input stay
// until that last step, so the transcript reads the same and a resumed turn
// still finds its tool parts.

/** What a compacted thread may weigh, in UTF-8 bytes: under the server's
 * character limit and the body limit, with room for the request around it. */
export const CLOUD_THREAD_BUDGET = 3_500_000;

const MEDIA_NOTE = "[media omitted from the cloud copy]";
const TRIM_NOTE = "Trimmed from the cloud copy; run the tool again if needed.";
/** Results smaller than this aren't worth a trim: a trimmed one weighs ~250. */
const TRIM_MIN_BYTES = 400;
const PREVIEW_CHARS = 160;

const encoder = new TextEncoder();
const bytesOf = (value: unknown) => encoder.encode(JSON.stringify(value) ?? "").length;

/** A thread's size as the cloud save sends it. */
export function cloudThreadBytes(thread: unknown): number {
  return bytesOf(thread);
}

type Part = { type?: unknown; output?: unknown; [key: string]: unknown };
type Message = { parts?: unknown; [key: string]: unknown };
type PiMessage = { role?: unknown; content?: unknown; details?: unknown; [key: string]: unknown };
type Thread = { messages?: unknown; pi?: unknown; [key: string]: unknown };

const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const isToolPart = (p: Part) => typeof p.type === "string" && (p.type.startsWith("tool-") || p.type === "dynamic-tool");

/** The value with every inline data URL replaced by a note; the same object
 * when there was none. */
function withoutMedia(value: unknown): unknown {
  if (typeof value === "string") return value.length > 256 && /^data:[^;,]+;base64,/.test(value) ? MEDIA_NOTE : value;
  if (Array.isArray(value)) {
    let changed = false;
    const out = value.map((v) => {
      const next = withoutMedia(v);
      if (next !== v) changed = true;
      return next;
    });
    return changed ? out : value;
  }
  if (isRecord(value)) {
    let changed = false;
    const out: Record<string, unknown> = {};
    for (const [key, v] of Object.entries(value)) {
      const next = withoutMedia(v);
      if (next !== v) changed = true;
      out[key] = next;
    }
    return changed ? out : value;
  }
  return value;
}

const preview = (value: unknown) => (JSON.stringify(value) ?? "").slice(0, PREVIEW_CHARS);

/** One trimmable result: where it sits in history (0 oldest, 1 newest), what
 * trimming it saves, and how. */
type Candidate = { age: number; saves: number; trim: () => void };

export function compactThreadForCloud<T>(thread: T, budget = CLOUD_THREAD_BUDGET): T {
  let size = bytesOf(thread);
  if (size <= budget || !isRecord(thread)) return thread;

  // Media first: nothing of it is readable as text anyway.
  const source = thread as Thread;
  let messages: Message[] = Array.isArray(source.messages) ? (source.messages as Message[]) : [];
  let pi: PiMessage[] | undefined = Array.isArray(source.pi) ? (source.pi as PiMessage[]) : undefined;
  messages = withoutMedia(messages) as Message[];
  if (pi) pi = withoutMedia(pi) as PiMessage[];
  // Copies from here on, so trims never reach the browser's own thread.
  messages = messages.map((m) => (Array.isArray(m.parts) ? { ...m, parts: [...(m.parts as Part[])] } : { ...m }));
  if (pi) pi = [...pi];
  const assemble = (): Thread => {
    const out: Thread = { ...source, messages };
    if (pi) out.pi = pi;
    else delete out.pi;
    return out;
  };
  size = bytesOf(assemble());
  if (size <= budget) return assemble() as T;

  // Then the bulkiest results, oldest first, transcript and pi alike.
  const candidates: Candidate[] = [];
  messages.forEach((message, m) => {
    const parts = message.parts as Part[] | undefined;
    parts?.forEach((part, p) => {
      if (!isRecord(part) || !isToolPart(part) || part.output === undefined) return;
      const before = bytesOf(part.output);
      if (before < TRIM_MIN_BYTES) return;
      const output = { trimmed: true, note: TRIM_NOTE, preview: preview(part.output) };
      candidates.push({
        age: messages.length > 1 ? m / (messages.length - 1) : 0,
        saves: before - bytesOf(output),
        trim: () => { parts[p] = { ...part, output }; },
      });
    });
  });
  pi?.forEach((message, i) => {
    if (!isRecord(message) || message.role !== "toolResult") return;
    const before = bytesOf(message.content) + bytesOf(message.details);
    if (before < TRIM_MIN_BYTES) return;
    const content = [{ type: "text", text: `${TRIM_NOTE} ${preview(message.content)}` }];
    const details = { trimmed: true };
    candidates.push({
      age: pi!.length > 1 ? i / (pi!.length - 1) : 0,
      saves: before - bytesOf(content) - bytesOf(details),
      trim: () => { pi![i] = { ...message, content, details }; },
    });
  });
  candidates.sort((a, b) => a.age - b.age);
  for (const candidate of candidates) {
    if (size <= budget) break;
    if (candidate.saves <= 0) continue;
    candidate.trim();
    size -= candidate.saves;
  }
  // The running total is exact for the parts it replaced; confirm it whole.
  size = bytesOf(assemble());
  if (size <= budget) return assemble() as T;

  // Then the pi context, which the browser still holds for its own resumes.
  pi = undefined;
  size = bytesOf(assemble());
  // Last, the oldest messages — the newest always goes up.
  while (size > budget && messages.length > 1) {
    size -= bytesOf(messages[0]) + 1;
    messages = messages.slice(1);
  }
  return assemble() as T;
}
