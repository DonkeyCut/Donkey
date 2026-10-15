import { expect, test } from "bun:test";
import { cloudThreadBytes, compactThreadForCloud, CLOUD_THREAD_BUDGET } from "./chatCompact";

type Part = { type: string; toolCallId?: string; state?: string; input?: unknown; output?: unknown; text?: string };
type Message = { id: string; role: string; parts: Part[] };
type Thread = { id: string; updatedAt: number; messages: Message[]; pi?: unknown[] };

const blob = (n: number) => "x".repeat(n);
// One agent turn the size of the incident's: 295 calls, each with its input
// and a JSON output, a few carrying a listen_audio clip the slim kept.
function turn(index: number, outputChars: number, audioEvery = 0): Message[] {
  const parts: Part[] = [{ type: "step-start" }, { type: "text", text: `turn ${index} reasoning` }];
  for (let call = 0; call < 295; call++) {
    const output: Record<string, unknown> = { ok: true, detail: blob(outputChars) };
    if (audioEvery && call % audioEvery === 0) output.audio = `data:audio/wav;base64,${blob(400_000)}`;
    parts.push({ type: "tool-add_title", toolCallId: `t${index}-${call}`, state: "output-available", input: { text: `title ${call}` }, output });
  }
  parts.push({ type: "text", text: `turn ${index} report` });
  return [
    { id: `u${index}`, role: "user", parts: [{ type: "text", text: `ask ${index}` }] },
    { id: `a${index}`, role: "assistant", parts },
  ];
}
const thread = (messages: Message[], pi?: unknown[]): Thread => ({ id: "th", updatedAt: 5, messages, ...(pi ? { pi } : {}) });
const toolParts = (t: Thread) => t.messages.flatMap((m) => m.parts.filter((p) => p.type.startsWith("tool-")));

test("a thread under the limit goes up as it is", () => {
  const small = thread(turn(0, 100));
  expect(compactThreadForCloud(small)).toBe(small);
});

test("a long chat's history fits the cloud copy with every turn, call and report kept", () => {
  // Fifteen incident-sized turns with listen_audio clips: well past the
  // server's 4,000,000-character limit.
  const big = thread(Array.from({ length: 15 }, (_, i) => turn(i, 1000, 60)).flat());
  expect(JSON.stringify(big).length).toBeGreaterThan(4_000_000);
  const fit = compactThreadForCloud(big) as Thread;
  expect(cloudThreadBytes(fit)).toBeLessThanOrEqual(CLOUD_THREAD_BUDGET);
  expect(fit.messages.map((m) => m.id)).toEqual(big.messages.map((m) => m.id));
  expect(toolParts(fit).map((p) => [p.toolCallId, p.state, p.input])).toEqual(toolParts(big).map((p) => [p.toolCallId, p.state, p.input]));
  const texts = (t: Thread) => t.messages.flatMap((m) => m.parts.filter((p) => p.type === "text").map((p) => p.text));
  expect(texts(fit)).toEqual(texts(big));
  // The media went first; the original is untouched.
  expect(JSON.stringify(fit)).not.toContain("data:audio");
  expect(JSON.stringify(big)).toContain("data:audio");
});

test("when media alone isn't enough, the oldest turns' outputs are trimmed and the newest stay whole", () => {
  const big = thread(Array.from({ length: 6 }, (_, i) => turn(i, 3000)).flat());
  const fit = compactThreadForCloud(big, 3_000_000) as Thread;
  expect(cloudThreadBytes(fit)).toBeLessThanOrEqual(3_000_000);
  const outputOf = (t: Thread, id: string) => t.messages.find((m) => m.id === id)!.parts.find((p) => p.type.startsWith("tool-"))!.output as Record<string, unknown>;
  expect(outputOf(fit, "a0").trimmed).toBe(true);
  expect(outputOf(fit, "a5")).toEqual(outputOf(big, "a5"));
});

test("the pi context's oldest tool results are trimmed with the transcript's", () => {
  const pi = Array.from({ length: 600 }, (_, i) => i % 2
    ? { role: "toolResult", toolCallId: `c${i}`, content: [{ type: "text", text: blob(4000) }], details: { response: { detail: blob(4000) } } }
    : { role: "assistant", content: [{ type: "toolCall", id: `c${i + 1}`, name: "add_title", arguments: {} }] });
  const big = thread(turn(0, 100), pi);
  const fit = compactThreadForCloud(big, 1_500_000) as Thread;
  expect(cloudThreadBytes(fit)).toBeLessThanOrEqual(1_500_000);
  const results = (fit.pi as { role: string; toolCallId?: string; details?: { trimmed?: boolean } }[]).filter((m) => m.role === "toolResult");
  expect(results).toHaveLength(300);
  expect(results[0].details?.trimmed).toBe(true);
  expect(results.at(-1)).toEqual((big.pi as unknown[]).at(-1) as never);
});
