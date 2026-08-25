import { describe, expect, test } from "bun:test";
import { TEXT_SAFE_WIDTH, textRoom, wrapTextToRoom } from "./render";

// A stand-in face: every glyph ten units wide, spaces included. Enough to pin
// down where the breaks land without a canvas.
const measure = (line: string) => line.length * 10;

describe("textRoom", () => {
  test("a centered anchor gets the whole safe width", () => {
    expect(textRoom(0.5, 1080)).toBeCloseTo(TEXT_SAFE_WIDTH * 1080);
  });

  test("an anchor near an edge only gets as far as that edge", () => {
    // 0.2 from the left: a centered box may reach 0.2 either way.
    expect(textRoom(0.2, 1000)).toBeCloseTo(400);
    expect(textRoom(0.8, 1000)).toBeCloseTo(400);
  });

  test("an anchor pinned to the edge keeps the promise the narrowing makes", () => {
    // Whatever room is handed back, a box centered on the anchor has to sit
    // inside the frame — there is no floor that quietly reaches past it.
    for (const x of [0, 0.02, 0.05, 0.09, 0.95, 1]) {
      const room = textRoom(x, 1000);
      expect(x * 1000 - room / 2).toBeGreaterThanOrEqual(-1e-9);
      expect(x * 1000 + room / 2).toBeLessThanOrEqual(1000 + 1e-9);
    }
  });
});

describe("wrapTextToRoom", () => {
  test("a line that fits stays on one line", () => {
    expect(wrapTextToRoom("before going to", 400, measure)).toBe("before going to");
  });

  test("a line that does not fit breaks between words", () => {
    expect(wrapTextToRoom("before going to bed", 100, measure)).toBe(
      "before\ngoing to\nbed"
    );
  });

  test("the author's own breaks survive", () => {
    expect(wrapTextToRoom("one\ntwo", 1000, measure)).toBe("one\ntwo");
  });

  test("a word wider than the room stands alone rather than being cut", () => {
    expect(wrapTextToRoom("a supercalifragilistic b", 60, measure)).toBe(
      "a\nsupercalifragilistic\nb"
    );
  });

  test("no room to speak of leaves the text alone", () => {
    expect(wrapTextToRoom("keep me", 0, measure)).toBe("keep me");
  });

  test("a line that fits keeps the spacing it was written with", () => {
    expect(wrapTextToRoom("HELLO   WORLD", 1000, measure)).toBe("HELLO   WORLD");
    expect(wrapTextToRoom("  indented", 1000, measure)).toBe("  indented");
  });
});
