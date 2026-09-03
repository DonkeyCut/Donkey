import { describe, expect, test } from "bun:test";
import { groupWordsIntoCues, transcribeLanguageCode } from "./transcribe";

describe("transcribeLanguageCode", () => {
  test("keeps a locale the model lists", () => {
    expect(transcribeLanguageCode("en-GB")).toBe("en-GB");
    expect(transcribeLanguageCode("pt-BR")).toBe("pt-BR");
    expect(transcribeLanguageCode("es-419")).toBe("es-419");
  });

  test("maps a bare or unlisted-region locale to the language's default", () => {
    expect(transcribeLanguageCode("en")).toBe("en-US");
    expect(transcribeLanguageCode("ko-KR")).toBe("ko-KR");
    expect(transcribeLanguageCode("zh-CN")).toBe("cmn-Hans-CN");
    expect(transcribeLanguageCode("fr_BE")).toBe("fr-FR");
  });

  test("sends no hint for a language the model does not list", () => {
    expect(transcribeLanguageCode("")).toBeUndefined();
    expect(transcribeLanguageCode("tlh")).toBeUndefined();
  });
});

describe("groupWordsIntoCues", () => {
  const word = (w: string, t0: number, t1: number) => ({ w, t0, t1 });

  test("caps a cue at seven words", () => {
    const words = Array.from({ length: 9 }, (_, i) => word(`w${i}`, i * 0.5, i * 0.5 + 0.4));
    const cues = groupWordsIntoCues(words);
    expect(cues.map((c) => c.words.length)).toEqual([7, 2]);
    expect([cues[0].start, cues[0].end, cues[0].text]).toEqual([0, 3.4, "w0 w1 w2 w3 w4 w5 w6"]);
  });

  test("breaks on a pause and after a sentence", () => {
    const cues = groupWordsIntoCues([
      word("Hello", 0, 0.3),
      word("there.", 0.35, 0.7),
      word("Long", 0.8, 1.1),
      word("pause", 2.5, 2.9),
      word("here", 2.95, 3.2),
    ]);
    expect(cues.map((c) => c.text)).toEqual(["Hello there.", "Long", "pause here"]);
    expect([cues[2].start, cues[2].end]).toEqual([2.5, 3.2]);
  });

  test("returns nothing for no words", () => {
    expect(groupWordsIntoCues([])).toEqual([]);
  });
});
