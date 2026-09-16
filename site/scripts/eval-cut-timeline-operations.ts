#!/usr/bin/env bun
import { strict as assert } from "node:assert";
import { componentFixture } from "./lib/cut-eval/componentFixture";

const { browser, page } = await componentFixture("timelineOperationsFixture.tsx");
try {
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.goto("http://preview.localhost");
  await page.waitForFunction(() => !!window.__cutDev);
  await page.evaluate(() => {
    window.__cutDev.useEditor.setState({
      projectId: "operations-fixture", readOnly: false, playing: false, loaded: true,
      timelineH: 700, pxPerSec: 60, selection: null, multiSelection: [],
      assets: [{ id: "media", name: "still", type: "image", duration: 30, width: 64, height: 64, url: 'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><rect width="64" height="64" fill="pink"/></svg>' }],
      clips: [{ id: "video", assetId: "media", track: 0, start: 0, in: 0, out: 20, muted: true }],
      audioClips: [],
      overlays: [
        { id: "effect", kind: "effect", effect: "blur", amount: 0.7, start: 1, end: 3, lane: 0, x: 0.5, y: 0.5 },
        { id: "text", kind: "text", text: "Title", start: 1, end: 3, lane: 1, x: 0.5, y: 0.5, size: 48, color: "#fff", shadow: false, plate: false },
        { id: "rect", kind: "shape", shape: "rect", fill: "#aaff33", start: 1, end: 3, lane: 2, x: 0.5, y: 0.5, w: 0.3, h: 0.3 },
        { id: "sticker", kind: "sticker", assetId: "media", start: 1, end: 3, lane: 3, x: 0.5, y: 0.5, w: 0.3 },
      ],
      transitions: [{ id: "transition", style: "crossfade", start: 1, seconds: 0.8 }],
    });
  });
  for (const id of ["effect", "text", "rect", "sticker", "transition"]) {
    const kind = id === "transition" ? "transition" : "overlay";
    const item = page.locator(`[data-tl-sel="${kind}:${id}"]`);
    await item.click({ position: { x: 20, y: 10 } });
    await page.keyboard.press("Meta+c");
    // Actual browser clipboard flavor, followed by the shared paste handler.
    let html = "";
    for (let attempt = 0; attempt < 50 && !html; attempt++) {
      html = await page.evaluate(async (id) => {
        try {
          const items = await navigator.clipboard.read();
          const value = await (await items[0].getType("text/html")).text();
          const encoded = value.match(/data-donkeycut="([^"]+)"/)?.[1];
          return encoded && JSON.parse(atob(encoded)).items.some((item: { item: { id: string } }) => item.item.id === id) ? value : "";
        } catch { return ""; }
      }, id);
      if (!html) await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert(html.includes("data-donkeycut"));
    await page.mouse.move(800, 100);
    await page.evaluate(() => window.__cutDev.useEditor.getState().seek(10));
    await page.evaluate((html) => {
      const data = new DataTransfer(); data.setData("text/html", html);
      window.dispatchEvent(new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }));
    }, html);
    await page.waitForFunction((id) => window.__cutDev.useEditor.getState().selection?.id !== id, id);
    const selection = await page.evaluate(() => window.__cutDev.useEditor.getState().selection!);
    assert.equal(selection.kind, kind);
    await page.locator(`[data-tl-sel="${kind}:${selection.id}"]`).waitFor();
    const pasted = await page.evaluate((sel) => {
      const s = window.__cutDev.useEditor.getState();
      return (sel.kind === "transition" ? s.transitions : s.overlays).find((x) => x.id === sel.id)!;
    }, selection);
    assert.equal(pasted.start, 10);
    if (id === "transition") {
      // A transition cannot split, so the toolbar shows no Split button.
      assert.equal(await page.getByRole("button", { name: "Split", exact: true }).count(), 0);
      await page.keyboard.press("s");
      assert.equal(await page.evaluate(() => window.__cutDev.useEditor.getState().clips.length), 1);
      assert.equal(await page.evaluate(() => window.__cutDev.useEditor.getState().transitions.length), 2);
    }
    await page.evaluate(() => window.__cutDev.useEditor.getState().undo());
    assert.equal(await page.locator(`[data-tl-sel="${kind}:${selection.id}"]`).count(), 0);
    console.log(`PASS ${id}: click, system copy, paste, visible bar and undo`);
  }
  const bar = page.locator('[data-tl-sel="transition:transition"]');
  const box = await bar.boundingBox(); assert(box);
  await page.mouse.move(box.x + 20, box.y + 10);
  await page.mouse.down();
  await page.mouse.move(box.x + 200, box.y + 10, { steps: 8 });
  await page.mouse.up();
  const moved = await page.evaluate(() => window.__cutDev.useEditor.getState().transitions[0]);
  assert(Math.abs(moved.start - 4) < 0.02);
  await page.evaluate(() => window.__cutDev.useEditor.getState().undo());
  assert.equal(await page.evaluate(() => window.__cutDev.useEditor.getState().transitions[0].start), 1);
  console.log("PASS transition: shared pointer movement and undo");
  for (const side of ["l", "r"]) {
    const handle = bar.locator(`.tl-trim-${side}`);
    const rect = await handle.boundingBox(); assert(rect);
    await page.mouse.move(rect.x + rect.width / 2, rect.y + rect.height / 2);
    await page.mouse.down();
    await page.mouse.move(rect.x + rect.width / 2 + 12, rect.y + rect.height / 2, { steps: 6 });
    await page.mouse.up();
    const trimmed = await page.evaluate(() => window.__cutDev.useEditor.getState().transitions[0]);
    assert(Math.abs(trimmed.seconds - (side === "l" ? 0.6 : 1)) < 0.02);
    assert.equal(await page.evaluate(() => window.__cutDev.useEditor.getState().clips[0].start), 0);
    await page.evaluate(() => window.__cutDev.useEditor.getState().undo());
    console.log(`PASS transition: shared ${side} trim, independent video and undo`);
  }
  await page.evaluate(() => {
    const s = window.__cutDev.useEditor.getState();
    s.setMultiSelection([{ kind: "overlay", id: "effect" }, { kind: "transition", id: "transition" }]);
  });
  const group = page.getByRole("button", { name: "Group", exact: true });
  const ungroup = page.getByRole("button", { name: "Ungroup", exact: true });
  // The toolbar shows Group for two or more items and Ungroup only for a
  // selection that holds a group.
  assert(await group.isEnabled());
  assert.equal(await ungroup.count(), 0);
  await group.click();
  await page.waitForFunction(() => !!window.__cutDev.useEditor.getState().transitions[0].groupId);
  assert(await ungroup.isEnabled());
  await ungroup.click();
  await page.waitForFunction(() => !window.__cutDev.useEditor.getState().transitions[0].groupId);
  await ungroup.waitFor({ state: "detached" });
  await group.click();
  console.log("PASS group toolbar follows grouping and ungrouping a mixed selection");
  const grouped = await bar.boundingBox(); assert(grouped);
  await page.mouse.move(grouped.x + 20, grouped.y + 10);
  await page.mouse.down();
  await page.mouse.move(grouped.x + 80, grouped.y + 10, { steps: 8 });
  await page.mouse.up();
  const state = await page.evaluate(() => {
    const s = window.__cutDev.useEditor.getState();
    return { effect: s.overlays.find((o) => o.id === "effect")!.start, transition: s.transitions[0].start, video: s.clips[0].start };
  });
  assert.deepEqual(state, { effect: 2, transition: 2, video: 0 });
  console.log("PASS mixed effect/transition group moves together and leaves video in place");
} finally { await browser.close(); }
