import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type React from "react";

import { startDrag } from "./drag";

const STUBBED = ["window", "document", "requestAnimationFrame", "cancelAnimationFrame"];

let events: EventTarget;
let saved: Map<string, PropertyDescriptor | undefined>;

// The drag listens on the window and paints once a frame; both run inline here.
beforeEach(() => {
  saved = new Map(STUBBED.map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  events = new EventTarget();
  Object.defineProperty(globalThis, "window", { configurable: true, value: events });
  Object.defineProperty(globalThis, "document", { configurable: true, value: { activeElement: null } });
  Object.defineProperty(globalThis, "requestAnimationFrame", { configurable: true, value: (cb: () => void) => (cb(), 0) });
  Object.defineProperty(globalThis, "cancelAnimationFrame", { configurable: true, value: () => {} });
});

afterEach(() => {
  for (const [key, descriptor] of saved) {
    if (descriptor) {
      Object.defineProperty(globalThis, key, descriptor);
    } else {
      Reflect.deleteProperty(globalThis, key);
    }
  }
});

// A press as the browser delivers it to a handler.
const press = (pointerId: number, isPrimary: boolean) =>
  ({
    button: 0,
    isPrimary,
    pointerId,
    clientX: 0,
    clientY: 0,
    currentTarget: {},
    preventDefault() {},
    stopPropagation() {},
  }) as unknown as React.PointerEvent;

const send = (type: string, pointerId: number, clientX: number) =>
  events.dispatchEvent(Object.assign(new Event(type), { pointerId, clientX, clientY: 0 }));

describe("a drag on a touch screen", () => {
  test("follows only the finger that started it", () => {
    const moves: number[] = [];
    const ups: number[] = [];
    startDrag(press(1, true), { onMove: (dx) => moves.push(dx), onUp: (dx) => ups.push(dx) });

    // A second finger lands and moves: the drag ignores it, release included.
    send("pointermove", 2, 90);
    send("pointerup", 2, 90);
    expect(moves).toEqual([]);
    expect(ups).toEqual([]);

    send("pointermove", 1, 30);
    send("pointerup", 1, 30);
    expect(moves).toEqual([30]);
    expect(ups).toEqual([30]);
  });

  test("a second finger landing ends the drag where the first one is", () => {
    const moves: number[] = [];
    const ups: number[] = [];
    startDrag(press(1, true), { onMove: (dx) => moves.push(dx), onUp: (dx) => ups.push(dx) });
    send("pointermove", 1, 20);

    // The pinch begins: the drag lands at 20 and the first finger moves no clip.
    events.dispatchEvent(Object.assign(new Event("pointerdown"), { pointerId: 2, pointerType: "touch", clientX: 80, clientY: 0 }));
    send("pointermove", 1, 60);
    send("pointerup", 1, 60);
    expect(moves).toEqual([20]);
    expect(ups).toEqual([20]);
  });

  test("a second finger's press starts nothing", () => {
    const moves: number[] = [];
    startDrag(press(2, false), { onMove: (dx) => moves.push(dx) });
    send("pointermove", 2, 40);
    expect(moves).toEqual([]);
  });
});
