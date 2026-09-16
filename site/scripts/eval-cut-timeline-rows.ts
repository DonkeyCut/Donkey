#!/usr/bin/env bun
import { strict as assert } from "node:assert";
import { componentFixture } from "./lib/cut-eval/componentFixture";
import { NEW_ROW_PX } from "../src/cut/lib/laneTracks";

const { browser, page } = await componentFixture("timelineRowsFixture.tsx");
try {
  await page.goto("http://preview.localhost");
  await page.waitForFunction(() => !!window.__cutDev);
  for (const kind of ["sticker", "shape", "effect"]) for (const side of ["above", "below", "existing", "empty"] as const) {
    await page.evaluate((empty) => {
      const store = window.__cutDev.useEditor;
      store.setState({
        projectId: "row-fixture", playing: false,
        clips: [{ id: "video", assetId: "sticker-asset", track: 0, start: 0, in: 0, out: 20, muted: true }],
        audioClips: [], overlays: [], transitions: [], selection: null, multiSelection: [], timelineH: 500, pxPerSec: 60,
        assets: [{ id: "sticker-asset", name: "sticker", type: "image", origin: "sticker", duration: 3, width: 64, height: 64, url: 'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><rect width="64" height="64" fill="pink"/></svg>' }],
      });
      if (!empty) {
        store.getState().addOverlay({ at: 0, lane: 0 });
        store.getState().addShape("rect", { at: 0, lane: 1 });
      }
      store.getState().select(null);
    }, side === "empty");
    await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    const before = await page.evaluate(() => window.__cutDev.useEditor.getState().overlays);
    const band = side === "empty" ? null : await page.locator("[data-tl-trows]").boundingBox();
    const video = await page.locator("[data-tl-vrow]").first().boundingBox();
    assert(video);
    const x = video.x + 400;
    const y = side === "empty" ? video.y + 30 : side === "above" ? band!.y - NEW_ROW_PX - 2 : side === "below" ? band!.y + band!.height + NEW_ROW_PX + 2 : band!.y + band!.height / 4;
    const data = await page.evaluateHandle(() => new DataTransfer());
    await page.locator(`[data-source="${kind}"]`).dispatchEvent("dragstart", { dataTransfer: data });
    const hover = async () => {
      await page.evaluate(({ x, y, data }) => document.elementFromPoint(x, y)!.dispatchEvent(new DragEvent("dragover", { bubbles: true, cancelable: true, clientX: x, clientY: y, dataTransfer: data })), { x, y, data });
      await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    };
    await hover();
    await hover(); // The row that opens must retain the same landing.
    const rows = await page.locator("[data-tl-trows]").boundingBox();
    assert(rows);
    if (side === "above" || side === "below") assert(rows.height > band!.height);
    await page.evaluate(({ x, y, data }) => document.elementFromPoint(x, y)!.dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, clientX: x, clientY: y, dataTransfer: data })), { x, y, data });
    await page.waitForFunction((count) => window.__cutDev.useEditor.getState().overlays.length === count, before.length + 1);
    const after = await page.evaluate(() => window.__cutDev.useEditor.getState().overlays);
    const added = after.find((o) => !before.some((b) => b.id === o.id))!;
    assert.equal(added.kind, kind);
    assert.equal(added.lane, side === "below" ? 2 : 0);
    for (const original of before) assert.equal(after.find((o) => o.id === original.id)?.lane, (original.lane ?? 0) + (side === "above" ? 1 : 0));
    await page.evaluate(() => window.__cutDev.useEditor.getState().undo());
    assert.deepEqual(await page.evaluate(() => window.__cutDev.useEditor.getState().overlays), before);
    await data.dispose();
    console.log(`PASS ${kind}: ${side} row, stable preview, drop and undo`);
  }
  for (const side of ["above", "below"]) {
    const id = await page.evaluate(() => {
      const store = window.__cutDev.useEditor;
      store.setState({ overlays: [], selection: null, multiSelection: [] });
      store.getState().addOverlay({ at: 0, lane: 0 });
      store.getState().addSticker({ assetId: "sticker-asset", at: 0, lane: 1 });
      store.getState().addSticker({ assetId: "sticker-asset", at: 5, lane: 1 });
      return store.getState().selection!.id;
    });
    const bar = await page.locator(`[data-tl-sel="overlay:${id}"]`).boundingBox();
    const band = await page.locator("[data-tl-trows]").boundingBox();
    assert(bar && band);
    const before = await page.evaluate(() => window.__cutDev.useEditor.getState().overlays);
    const x = bar.x + bar.width / 2;
    const y = side === "above" ? band.y - NEW_ROW_PX - 2 : band.y + band.height + NEW_ROW_PX + 2;
    await page.mouse.move(x, bar.y + bar.height / 2);
    await page.mouse.down();
    await page.mouse.move(x, y, { steps: 8 });
    await page.mouse.up();
    const after = await page.evaluate(() => window.__cutDev.useEditor.getState().overlays);
    assert.equal(after.find((o) => o.id === id)?.lane, side === "above" ? 0 : 2);
    await page.evaluate(() => window.__cutDev.useEditor.getState().undo());
    assert.deepEqual(await page.evaluate(() => window.__cutDev.useEditor.getState().overlays), before);
    console.log(`PASS existing sticker: drag to new row ${side} and undo`);
  }
  // A group drag reorders the whole set past the band's edges: the grabbed
  // member reaches the new row and the rest open the rows beyond it.
  for (const side of ["above", "below"] as const) {
    const ids = await page.evaluate(() => {
      const store = window.__cutDev.useEditor;
      store.setState({ overlays: [], selection: null, multiSelection: [] });
      store.getState().addOverlay({ at: 0, lane: 0 });
      const title = store.getState().selection!.id;
      store.getState().addSticker({ assetId: "sticker-asset", at: 0, lane: 1 });
      const a = store.getState().selection!.id;
      store.getState().addSticker({ assetId: "sticker-asset", at: 5, lane: 2 });
      const b = store.getState().selection!.id;
      return { title, a, b };
    });
    const grabbed = side === "below" ? ids.title : ids.b;
    const other = ids.a;
    await page.evaluate(({ grabbed, other }) => {
      window.__cutDev.useEditor.getState().setMultiSelection([{ kind: "overlay", id: grabbed }, { kind: "overlay", id: other }]);
    }, { grabbed, other });
    const bar = await page.locator(`[data-tl-sel="overlay:${grabbed}"]`).boundingBox();
    const band = await page.locator("[data-tl-trows]").boundingBox();
    assert(bar && band);
    const before = await page.evaluate(() => window.__cutDev.useEditor.getState().overlays);
    const x = bar.x + bar.width / 2;
    const y = side === "above" ? band.y - NEW_ROW_PX - 2 : band.y + band.height + NEW_ROW_PX + 2;
    await page.mouse.move(x, bar.y + bar.height / 2);
    await page.mouse.down();
    await page.mouse.move(x, y, { steps: 8 });
    const rows = await page.locator("[data-tl-trows]").boundingBox();
    assert(rows && rows.height > band.height);
    await page.mouse.up();
    const lanes = await page.evaluate(() => Object.fromEntries(window.__cutDev.useEditor.getState().overlays.map((o) => [o.id, o.lane ?? 0])));
    if (side === "below") assert.deepEqual(lanes, { [ids.b]: 0, [ids.title]: 1, [ids.a]: 2 });
    else assert.deepEqual(lanes, { [ids.a]: 0, [ids.b]: 1, [ids.title]: 2 });
    await page.evaluate(() => window.__cutDev.useEditor.getState().undo());
    assert.deepEqual(await page.evaluate(() => window.__cutDev.useEditor.getState().overlays), before);
    console.log(`PASS group: drag two members to new rows ${side} and undo`);
  }
} finally {
  await browser.close();
}
