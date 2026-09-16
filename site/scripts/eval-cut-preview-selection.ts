#!/usr/bin/env bun
/** Real pointer gestures on the Preview component, with an in-memory project. */
import { strict as assert } from "node:assert";
import type { Page } from "playwright";
import { componentFixture } from "./lib/cut-eval/componentFixture";
import type { EditorState } from "../src/cut/lib/store";
import type { TextOverlay } from "../src/cut/lib/types";

declare global {
  interface Window {
    __cutDev: { useEditor: { getState(): EditorState; setState(state: Partial<EditorState>): void } };
  }
}

const { browser, page } = await componentFixture("previewSelectionFixture.tsx");

async function selected(page: Page) {
  return page.evaluate(() => window.__cutDev.useEditor.getState().multiSelection.map((s) => `${s?.kind}:${s?.id}`).sort());
}

type Modifier = "Meta" | "Control" | "Shift";
async function click(x: number, y: number, keys: Modifier[]) {
  if (process.platform === "darwin" && keys.includes("Control")) {
    // macOS translates native Ctrl-click to a context menu. Send the primary
    // pointer/click sequence Windows delivers, through the real DOM hit target.
    await page.evaluate(({ x, y, shiftKey }) => {
      const target = document.elementFromPoint(x, y)!;
      const init = { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0, ctrlKey: true, shiftKey };
      target.dispatchEvent(new PointerEvent("pointerdown", { ...init, buttons: 1, pointerId: 1, pointerType: "mouse" }));
      const released = document.elementFromPoint(x, y)!;
      released.dispatchEvent(new PointerEvent("pointerup", { ...init, pointerId: 1, pointerType: "mouse" }));
      released.dispatchEvent(new MouseEvent("click", init));
    }, { x, y, shiftKey: keys.includes("Shift") });
  } else {
    for (const key of keys) await page.keyboard.down(key);
    await page.mouse.click(x, y);
    for (const key of [...keys].reverse()) await page.keyboard.up(key);
  }
}

try {
  await page.goto("http://preview.localhost", { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => !!window.__cutDev);
  const modifiers: Modifier[][] = [["Meta"], ["Shift"], ["Meta", "Shift"], ["Control"], ["Control", "Shift"]];
  for (const keys of modifiers) {
    await page.evaluate(() => {
      const store = window.__cutDev.useEditor;
      const title = (id: string, x: number, y: number): TextOverlay => ({ id, text: id, start: 0, end: 4, x, y, size: 60, font: "sf", weight: 700, color: "#fff", shadow: false, plate: false });
      store.setState({
        playing: false, selection: null, multiSelection: [], assets: [], audioClips: [], transitions: [],
        overlays: [title("a", 0.25, 0.25), title("b", 0.75, 0.25)],
        clips: [{ id: "video", assetId: "fixture", track: 0, start: 0, in: 0, out: 4, muted: true }],
        subtitles: { ...store.getState().subtitles, cues: [{ id: "caption", start: 0, end: 4, text: "Caption" }], tracks: [{ x: 0.5, y: 0.75 }] },
      });
      store.getState().seek(1);
    });
    const a = page.locator('.overlay-item[data-preview-id="a"]');
    const b = page.locator('.overlay-item[data-preview-id="b"]');
    const caption = page.locator('.sub-caption[data-preview-id="caption"]');
    const clickAt = async (locator: typeof a, mods: typeof keys) => {
      const box = await locator.boundingBox();
      assert(box);
      await click(box.x + box.width / 2, box.y + box.height / 2, mods);
    };
    await a.waitFor({ state: "visible" });
    await clickAt(a, []);
    assert.deepEqual(await selected(page), ["overlay:a"]);
    await clickAt(b, keys);
    assert.deepEqual(await selected(page), ["overlay:a", "overlay:b"]);
    await clickAt(caption, keys);
    assert.deepEqual(await selected(page), ["cue:caption", "overlay:a", "overlay:b"]);
    const stage = await page.locator(".stage").boundingBox();
    assert(stage);
    await click(stage.x + 15, stage.y + 15, keys);
    assert.deepEqual(await selected(page), ["clip:video", "cue:caption", "overlay:a", "overlay:b"]);
    // Full-frame clip chrome covers titles; picking must still reach the title.
    await clickAt(b, keys);
    assert.deepEqual(await selected(page), ["clip:video", "cue:caption", "overlay:a"]);
    await clickAt(b, keys);
    assert.deepEqual(await selected(page), ["clip:video", "cue:caption", "overlay:a", "overlay:b"]);
    // Deselecting a clip removes its hit box before the generated click arrives.
    await click(stage.x + 15, stage.y + 15, keys);
    assert.deepEqual(await selected(page), ["cue:caption", "overlay:a", "overlay:b"]);
    const box = await a.boundingBox();
    assert(box);
    const before = await page.evaluate(() => window.__cutDev.useEditor.getState().overlays.map((o) => ({ x: o.x, y: o.y })));
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2 + 30, box.y + box.height / 2 + 20, { steps: 5 });
    await page.mouse.up();
    const after = await page.evaluate(() => window.__cutDev.useEditor.getState().overlays.map((o) => ({ x: o.x, y: o.y })));
    assert(after[0].x > before[0].x);
    assert(Math.abs((after[1].x - before[1].x) - (after[0].x - before[0].x)) < 1e-6);
    await page.evaluate(() => window.__cutDev.useEditor.getState().undo());
    assert.deepEqual(await page.evaluate(() => window.__cutDev.useEditor.getState().overlays.map((o) => ({ x: o.x, y: o.y }))), before);
    console.log(`PASS ${keys.join("+")}${process.platform === "darwin" && keys.includes("Control") ? " (Windows event sequence)" : ""}: add/remove titles, caption, full-frame video, overlapping chrome, group drag and undo`);
  }
} finally {
  await browser.close();
}
