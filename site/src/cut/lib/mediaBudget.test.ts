import { describe, expect, test } from "bun:test";
import { enforceMediaBudget } from "./mediaBudget";

type Item = Record<string, unknown>;

/** A media part whose payload decodes to `bytes`. */
const media = (bytes: number): Item => ({
  type: "input_audio",
  dataBase64: "A".repeat(Math.ceil((bytes * 4) / 3)),
  mimeType: "audio/aac",
});

const mediaTotal = (input: Item[]): number =>
  input.reduce((n, item) => {
    const content = item.content;
    if (!Array.isArray(content)) return n;
    return (
      n +
      content.reduce(
        (m: number, p: Item) =>
          m + (typeof p.dataBase64 === "string" ? Math.floor(p.dataBase64.length * 0.75) : 0),
        0
      )
    );
  }, 0);

describe("enforceMediaBudget", () => {
  test("leaves an input under budget untouched", () => {
    const turn: Item = { role: "user", content: [{ text: "hear this:" }, media(100)] };
    const input = [turn];
    enforceMediaBudget(input, 1000);
    expect(input[0]).toBe(turn);
    expect((input[0].content as Item[]).length).toBe(2);
  });

  test("drops the oldest media first and keeps the newest", () => {
    const input: Item[] = [
      { role: "user", content: [{ text: "old audio:" }, media(600)] },
      { role: "user", content: [{ text: "new audio:" }, media(600)] },
    ];
    enforceMediaBudget(input, 1000);
    const oldParts = input[0].content as Item[];
    const newParts = input[1].content as Item[];
    expect(oldParts.some((p) => typeof p.dataBase64 === "string")).toBe(false);
    expect(oldParts[0]).toEqual({ text: "old audio:" });
    expect(String(oldParts.at(-1)?.text)).toContain("dropped");
    expect(newParts.some((p) => typeof p.dataBase64 === "string")).toBe(true);
    expect(mediaTotal(input)).toBeLessThanOrEqual(1000);
  });

  test("trims within a step and keeps the parts that still fit", () => {
    const input: Item[] = [
      { role: "user", content: [media(600), media(600), { text: "label" }] },
    ];
    enforceMediaBudget(input, 700);
    const parts = input[0].content as Item[];
    expect(parts.filter((p) => typeof p.dataBase64 === "string").length).toBe(1);
    expect(parts.some((p) => p.text === "label")).toBe(true);
    expect(String(parts.at(-1)?.text)).toContain("dropped");
    expect(mediaTotal(input)).toBeLessThanOrEqual(700);
  });

  test("always lands under budget, even when the newest step alone exceeds it", () => {
    const input: Item[] = [
      { role: "user", content: [media(500)] },
      { role: "user", content: [media(900), media(900)] },
    ];
    enforceMediaBudget(input, 1000);
    expect(mediaTotal(input)).toBeLessThanOrEqual(1000);
  });

  test("keeps assistant function calls and thought signatures intact", () => {
    const call: Item = {
      role: "assistant",
      content: [{ functionCall: { id: "x", name: "seek", args: {} }, thoughtSignature: "sig" }],
    };
    const input: Item[] = [call, { role: "user", content: [media(600), media(600)] }];
    enforceMediaBudget(input, 700);
    expect(input[0]).toBe(call);
    expect((input[0].content as Item[])[0].thoughtSignature).toBe("sig");
  });
});
