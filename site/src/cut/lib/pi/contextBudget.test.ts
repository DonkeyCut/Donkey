import { describe, expect, test } from "bun:test";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { enforceContextBudget } from "./contextBudget";
import type { DonkeyToolDetails, WireCarrier, WirePart } from "./donkeyStream";

/** A wire media part whose payload decodes to `bytes`. */
const media = (bytes: number): WirePart => ({
  type: "input_audio",
  dataBase64: "A".repeat(Math.ceil((bytes * 4) / 3)),
  mimeType: "audio/aac",
});

const userWithMedia = (text: string, bytes: number): AgentMessage =>
  ({
    role: "user",
    content: [{ type: "text", text }],
    timestamp: 0,
    wireParts: [media(bytes)],
  }) as AgentMessage & WireCarrier;

const totalBytes = (msgs: AgentMessage[]): number =>
  msgs.reduce((n, m) => {
    const wire = ((m as WireCarrier).wireParts ?? []) as WirePart[];
    const details = (m as { details?: DonkeyToolDetails }).details;
    const parts = [...wire, ...(details?.mediaParts ?? [])];
    return (
      n +
      parts.reduce(
        (b, p) =>
          b + (typeof p.dataBase64 === "string" ? Math.floor(p.dataBase64.length * 0.75) : 0),
        0
      )
    );
  }, 0);

describe("enforceContextBudget", () => {
  test("returns the input untouched under budget", () => {
    const msgs = [userWithMedia("hear this:", 100)];
    expect(enforceContextBudget(msgs, 1000)).toBe(msgs);
  });

  test("drops the oldest media first, keeps the newest, never mutates", () => {
    const oldTurn = userWithMedia("old audio:", 600);
    const msgs = [oldTurn, userWithMedia("new audio:", 600)];
    const out = enforceContextBudget(msgs, 1000);
    const trimmed = out[0] as unknown as WireCarrier & {
      content: { type: string; text?: string }[];
    };
    expect(trimmed.wireParts).toHaveLength(0);
    const texts = trimmed.content.map((c) => c.text);
    expect(texts[0]).toBe("old audio:");
    expect(String(texts.at(-1))).toContain("dropped");
    expect(totalBytes(out)).toBeLessThanOrEqual(1000);
    // The stored session keeps its media: the original message is untouched.
    expect(((oldTurn as WireCarrier).wireParts ?? []).length).toBe(1);
    expect(((out[1] as WireCarrier).wireParts ?? []).length).toBe(1);
  });

  test("trims within a message, keeping the parts that still fit", () => {
    const msg = {
      role: "user",
      content: [{ type: "text", text: "two clips:" }],
      timestamp: 0,
      wireParts: [media(600), media(500)],
    } as AgentMessage & WireCarrier;
    const out = enforceContextBudget([msg], 700);
    const trimmed = out[0] as unknown as WireCarrier & {
      content: { type: string; text?: string }[];
    };
    expect(trimmed.wireParts).toHaveLength(1);
    expect(String(trimmed.content.at(-1)?.text)).toContain("dropped");
    expect(totalBytes(out)).toBeLessThanOrEqual(700);
  });

  test("sheds tool-result media into a note, keeping the JSON response", () => {
    const toolMsg = {
      role: "toolResult",
      toolCallId: "t1",
      toolName: "listen_audio",
      content: [{ type: "text", text: "{}" }],
      details: { response: { ok: true }, mediaParts: [media(900)] },
      isError: false,
      timestamp: 0,
    } as AgentMessage;
    const out = enforceContextBudget([toolMsg, userWithMedia("new:", 600)], 700);
    const details = (out[0] as { details: DonkeyToolDetails }).details;
    expect(details.response).toEqual({ ok: true });
    expect(String(details.mediaParts?.[0]?.text)).toContain("dropped");
    expect(totalBytes(out)).toBeLessThanOrEqual(700);
  });

  test("assistant messages pass through by reference", () => {
    const call = {
      role: "assistant",
      content: [{ type: "toolCall", id: "x", name: "seek", arguments: {}, thoughtSignature: "sig" }],
      api: "donkey-responses",
      provider: "donkey",
      model: "m",
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "toolUse",
      timestamp: 0,
    } as AgentMessage;
    const out = enforceContextBudget([call, userWithMedia("a", 600), userWithMedia("b", 600)], 700);
    expect(out[0]).toBe(call);
  });
});
