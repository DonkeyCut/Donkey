import os from "node:os";
import { query, type SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { visualSubtitlesPrompt } from "./captionPrompts";

// Write subtitle cues for a cut with no usable audio: the client samples frames
// along the timeline, and the user's own Claude login (like the rest of Cut's
// AI) watches them and writes timed narration captions.

/** One sampled frame: its timeline time and a data-URL jpeg/png. */
export interface VisualFrame {
  at: number;
  image: string;
}

export interface VisualCue {
  start: number;
  end: number;
  text: string;
}

const MODEL = "claude-haiku-5-5";
const MAX_FRAMES = 24;

type ImageBlock = {
  type: "image";
  source: { type: "base64"; media_type: "image/jpeg" | "image/png" | "image/webp"; data: string };
};

function imageBlock(dataUrl: string): ImageBlock | null {
  const m = /^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=]+)$/.exec(dataUrl);
  if (!m) return null;
  return {
    type: "image",
    source: { type: "base64", media_type: m[1] as ImageBlock["source"]["media_type"], data: m[2] },
  };
}

export async function writeVisualCues(
  frames: VisualFrame[],
  duration: number,
  locale?: string
): Promise<VisualCue[]> {
  const usable = frames
    .slice(0, MAX_FRAMES)
    .map((f) => ({ at: Math.max(0, f.at), block: imageBlock(f.image) }))
    .filter((f): f is { at: number; block: ImageBlock } => f.block !== null);
  if (usable.length === 0) throw new Error("No frames to caption.");

  const content: ({ type: "text"; text: string } | ImageBlock)[] = [
    { type: "text", text: visualSubtitlesPrompt(duration, locale) },
  ];
  for (const f of usable) {
    content.push({ type: "text", text: `Frame at ${f.at.toFixed(1)}s:` });
    content.push(f.block);
  }

  async function* messages(): AsyncIterable<SDKUserMessage> {
    yield {
      type: "user",
      message: { role: "user", content },
      parent_tool_use_id: null,
    };
  }

  const text = await runOnce(messages(), 120_000);
  const cues = parseCues(text, duration);
  if (cues.length === 0) throw new Error("The model wrote no captions — try again.");
  return cues;
}

async function runOnce(prompt: AsyncIterable<SDKUserMessage>, timeoutMs: number): Promise<string> {
  const q = query({
    prompt,
    options: {
      model: MODEL,
      ...(process.env.DONKEY_CUT_CLAUDE
        ? { pathToClaudeCodeExecutable: process.env.DONKEY_CUT_CLAUDE }
        : {}),
      tools: [],
      permissionMode: "dontAsk",
      settingSources: [],
      maxTurns: 1,
      cwd: os.tmpdir(),
    },
  });
  const collect = async () => {
    let out = "";
    for await (const msg of q) {
      const m = msg as unknown as { type: string; subtype?: string; result?: unknown };
      if (m.type === "result" && m.subtype === "success" && typeof m.result === "string") {
        out = m.result;
      }
    }
    return out;
  };
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error("Captioning timed out.")), timeoutMs);
    timer.unref();
  });
  try {
    return await Promise.race([collect(), timeout]);
  } catch (err) {
    // Losing the race only abandons the promise — stop the underlying Claude
    // subprocess too, or every timeout strands one burning CPU and quota.
    void q.interrupt().catch(() => {});
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

/** Pull the JSON cue array out of the reply and normalize it: clamp to the
 * cut, keep chronological order, and nudge overlaps apart. */
function parseCues(text: string, duration: number): VisualCue[] {
  const start = text.indexOf("[");
  const end = text.lastIndexOf("]");
  if (start === -1 || end <= start) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(text.slice(start, end + 1));
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const cues = parsed
    .map((c) => {
      const v = c as { start?: unknown; end?: unknown; text?: unknown };
      if (typeof v.start !== "number" || typeof v.end !== "number" || typeof v.text !== "string")
        return null;
      const s = Math.max(0, Math.min(v.start, duration));
      const e = Math.max(s + 0.3, Math.min(v.end, duration + 0.5));
      const t = v.text.replace(/\s+/g, " ").trim();
      return t ? { start: s, end: e, text: t } : null;
    })
    .filter((c): c is VisualCue => c !== null)
    .sort((a, b) => a.start - b.start);
  for (let i = 1; i < cues.length; i++) {
    if (cues[i].start < cues[i - 1].end) cues[i].start = cues[i - 1].end;
    if (cues[i].end < cues[i].start + 0.3) cues[i].end = cues[i].start + 0.3;
  }
  return cues;
}
