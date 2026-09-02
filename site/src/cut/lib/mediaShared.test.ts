import { describe, expect, test } from "bun:test";
import { openMediaShared } from "./mediaRead";

const URL_A = "https://media.donkeycut.com/cut/u1/projects/p1/media/a.mp4?e=1&s=x";
const URL_B = "https://media.donkeycut.com/cut/u1/projects/p1/media/b.mp4?e=1&s=x";

describe("openMediaShared", () => {
  test("holders on one URL share one input; another URL gets its own", () => {
    const a = openMediaShared(URL_A);
    const b = openMediaShared(URL_A);
    const c = openMediaShared(URL_B);
    expect(a.input).toBe(b.input);
    expect(c.input).not.toBe(a.input);
    a.release();
    b.release();
    c.release();
  });

  test("the file stays open until the last holder lets go", () => {
    const a = openMediaShared(URL_A);
    const b = openMediaShared(URL_A);
    a.release();
    // One holder still has it: a new holder joins the same input.
    const c = openMediaShared(URL_A);
    expect(c.input).toBe(b.input);
    b.release();
    c.release();
  });

  test("once every holder is gone, the next open is a fresh file", () => {
    const a = openMediaShared(URL_A);
    const input = a.input;
    a.release();
    const b = openMediaShared(URL_A);
    expect(b.input).not.toBe(input);
    b.release();
  });

  test("a holder releasing twice is nothing", () => {
    const a = openMediaShared(URL_A);
    const b = openMediaShared(URL_A);
    a.release();
    a.release();
    // b still holds the file: a third holder joins it.
    const c = openMediaShared(URL_A);
    expect(c.input).toBe(b.input);
    b.release();
    c.release();
  });
});
