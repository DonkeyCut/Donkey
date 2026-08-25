"use client";

import { useEffect, useState } from "react";
import { useExports } from "@/cut/lib/exportStore";
import { useGenerate } from "@/cut/lib/generate";
import { useEditor } from "@/cut/lib/store";
import { useTabActivity } from "@/cut/lib/tabActivity";

/**
 * The tab says what it is doing.
 *
 * Work here runs long and the user goes elsewhere while it does, so the two
 * things visible from another tab carry the state: the favicon and the title.
 * The icon stays the donkey and takes a badge in its corner — amber, carrying
 * how many jobs are under way, then green with a check once the last of them
 * settles. The check waits for the user: until they look at the tab, or a few
 * seconds if they were already looking. Then the tab goes back to being the
 * project's name and the plain donkey.
 */

const DONE_MARK = "✓ ";
/** How long the finished mark holds when the user is already on the tab. */
const DONE_MS = 6000;
/** The art already in the tab; the badge is painted over a copy of it. */
const BASE_ICON = "/favicon.ico";
const BUSY_COLOR = "#ff9500";
const DONE_COLOR = "#30d158";

/** Take back a mark this component put in front of the title, and nothing else. */
const strip = (title: string) => title.replace(/^(?:[✓●]|\(\d+\+?\)) /, "");

/** What the badge and the title say when several jobs run at once. */
const tally = (count: number) => (count > 9 ? "9+" : String(count));

/**
 * The link this component paints on — its own, never the page's.
 *
 * The site's icon is declared in the app metadata, so React renders that link
 * and owns the node. Taking it out of the head leaves React holding a node
 * with no parent, and the next render that tries to remove it throws. This
 * one is appended after it instead: the browser takes the last icon declared,
 * and handing the tab back is a matter of dropping this link again.
 */
function iconLink(): HTMLLinkElement {
  const held = document.querySelector<HTMLLinkElement>("link[data-tab-status]");
  if (held) return held;
  const link = document.createElement("link");
  link.rel = "icon";
  link.dataset.tabStatus = "";
  document.head.appendChild(link);
  return link;
}

/** Hand the tab back: this link goes and the page's own icon, still in the
 * head where React put it, is what the browser is left with. */
function dropIconLink(): void {
  document.querySelector("link[data-tab-status]")?.remove();
}

let baseIcon: HTMLImageElement | null = null;
let baseLoad: Promise<void> | null = null;

/** The tab's own art, decoded once, so the badge has something to sit on. */
function loadBase(): Promise<void> {
  baseLoad ??= new Promise<void>((resolve) => {
    const img = new Image();
    img.onload = () => {
      baseIcon = img;
      resolve();
    };
    // The badge alone still reads if the art never arrives.
    img.onerror = () => resolve();
    img.src = BASE_ICON;
  });
  return baseLoad;
}

/** The icon with its badge: a count while work runs, a check once it is done. */
function paint(state: "busy" | "done", count: number): string {
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = 64;
  const ctx = canvas.getContext("2d");
  if (!ctx) return "";
  // Drawn in 32 units at twice the size, which is what a retina tab asks for.
  ctx.scale(2, 2);
  if (baseIcon) ctx.drawImage(baseIcon, 0, 0, 32, 32);

  const x = 22.5;
  const y = 22.5;
  // A ring in the icon's own white sets the badge off from the art beneath it.
  ctx.fillStyle = "#ffffff";
  ctx.beginPath();
  ctx.arc(x, y, 9.5, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = state === "busy" ? BUSY_COLOR : DONE_COLOR;
  ctx.beginPath();
  ctx.arc(x, y, 7.5, 0, Math.PI * 2);
  ctx.fill();

  if (state === "busy") {
    const label = tally(count);
    ctx.fillStyle = "#ffffff";
    // Two glyphs have to fit the same circle one does.
    ctx.font = `bold ${label.length > 1 ? 9 : 11}px ui-sans-serif, -apple-system, system-ui, sans-serif`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(label, x, y + 0.5);
  } else {
    ctx.strokeStyle = "#ffffff";
    ctx.lineWidth = 2.4;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.beginPath();
    ctx.moveTo(x - 3.6, y + 0.2);
    ctx.lineTo(x - 1.1, y + 2.7);
    ctx.lineTo(x + 3.8, y - 2.9);
    ctx.stroke();
  }
  return canvas.toDataURL("image/png");
}

export function TabStatus() {
  // The title is repainted when the project is renamed, which takes the mark
  // with it, so the name is a dependency of the paint.
  const projectName = useEditor((s) => s.projectName);
  const [count, setCount] = useState(0);
  const [done, setDone] = useState(false);
  const busy = count > 0;

  // Four stores answer for the work, so the state is read off them together
  // whenever any one moves: the badge carries how much is running, and what
  // matters after that is the moment the last of it stops.
  useEffect(() => {
    let was = 0;
    const read = () => {
      const activity = useTabActivity.getState().running;
      const editor = useEditor.getState();
      const exports = useExports.getState();
      return (
        Object.values(activity).filter(Boolean).length +
        useGenerate.getState().jobs.filter((j) => j.status === "running").length +
        editor.renders.filter((r) => r.status === "running").length +
        (editor.subtitleStatus === "running" ? 1 : 0) +
        exports.local.filter((r) => r.status !== "error").length +
        exports.jobs.filter((j) => j.status === "queued" || j.status === "running").length
      );
    };
    const apply = () => {
      const now = read();
      if (now === was) return;
      was = now;
      setCount(now);
      // Starting clears the last finish; stopping is the finish.
      setDone(now === 0);
    };
    const off = [
      useTabActivity.subscribe(apply),
      useGenerate.subscribe(apply),
      useEditor.subscribe(apply),
      useExports.subscribe(apply),
    ];
    apply();
    return () => off.forEach((f) => f());
  }, []);

  // The finished mark is for someone who was elsewhere, so it waits for them;
  // on a tab they are already looking at it says its piece and goes.
  useEffect(() => {
    if (!done) return;
    if (!document.hidden) {
      const t = setTimeout(() => setDone(false), DONE_MS);
      return () => clearTimeout(t);
    }
    const seen = () => {
      if (!document.hidden) setDone(false);
    };
    document.addEventListener("visibilitychange", seen);
    window.addEventListener("focus", seen);
    return () => {
      document.removeEventListener("visibilitychange", seen);
      window.removeEventListener("focus", seen);
    };
  }, [done]);

  useEffect(() => {
    const base = strip(document.title);
    if (!busy && !done) {
      document.title = base;
      dropIconLink();
      return;
    }
    const link = iconLink();
    document.title = (busy ? `(${tally(count)}) ` : DONE_MARK) + base;
    let live = true;
    const render = () => {
      if (live) link.href = paint(busy ? "busy" : "done", count);
    };
    render();
    // The art decodes once; the badge painted before it lands is repainted on it.
    if (!baseIcon) void loadBase().then(render);
    return () => {
      live = false;
    };
  }, [busy, done, count, projectName]);

  // Leaving the editor leaves the tab as it was found.
  useEffect(() => dropIconLink, []);

  return null;
}
