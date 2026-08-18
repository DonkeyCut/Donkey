"use client";

import { useEffect, useState } from "react";
import { useExports } from "@/cut/lib/exportStore";
import { useGenerate } from "@/cut/lib/generate";
import { useEditor } from "@/cut/lib/store";
import { busyIn, useTabActivity } from "@/cut/lib/tabActivity";

/**
 * The tab says what it is doing.
 *
 * Work here runs long and the user goes elsewhere while it does, so the two
 * things visible from another tab carry the state: the favicon and the title.
 * A ring turns while anything is running, and when the last of it settles a
 * green check takes its place and waits — until the user looks at the tab, or
 * a few seconds if they were already looking. Then the tab goes back to being
 * the project's name and the donkey.
 */

const BUSY_MARK = "● ";
const DONE_MARK = "✓ ";
/** How long the finished mark holds when the user is already on the tab. */
const DONE_MS = 6000;
const SPIN_MS = 90;

const strip = (title: string) =>
  title.startsWith(BUSY_MARK) || title.startsWith(DONE_MARK) ? title.slice(2) : title;

function iconLink(): HTMLLinkElement {
  const held = document.querySelector<HTMLLinkElement>("link[data-tab-status]");
  if (held) return held;
  const link = document.createElement("link");
  link.rel = "icon";
  link.dataset.tabStatus = "";
  // The page's own icon, kept so the tab can be handed back as it was.
  const first = document.querySelector<HTMLLinkElement>("link[rel~='icon']");
  link.dataset.rest = first?.href ?? "/favicon.ico";
  first?.remove();
  document.head.appendChild(link);
  return link;
}

/** The status icon: a turning ring, or a check on a green disc. */
function paint(state: "busy" | "done", turn: number): string {
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = 32;
  const ctx = canvas.getContext("2d");
  if (!ctx) return "";
  ctx.lineCap = "round";
  if (state === "busy") {
    ctx.strokeStyle = "rgba(10,132,255,0.2)";
    ctx.lineWidth = 5;
    ctx.beginPath();
    ctx.arc(16, 16, 12, 0, Math.PI * 2);
    ctx.stroke();
    ctx.strokeStyle = "#0a84ff";
    ctx.beginPath();
    ctx.arc(16, 16, 12, turn, turn + Math.PI * 1.3);
    ctx.stroke();
  } else {
    ctx.fillStyle = "#30d158";
    ctx.beginPath();
    ctx.arc(16, 16, 15, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = "#ffffff";
    ctx.lineWidth = 4;
    ctx.lineJoin = "round";
    ctx.beginPath();
    ctx.moveTo(9, 16.5);
    ctx.lineTo(14, 21.5);
    ctx.lineTo(23, 11);
    ctx.stroke();
  }
  return canvas.toDataURL("image/png");
}

export function TabStatus() {
  // The title is repainted when the project is renamed, which takes the mark
  // with it, so the name is a dependency of the paint.
  const projectName = useEditor((s) => s.projectName);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);

  // Four stores answer for the work, so the state is read off them together
  // whenever any one moves: what matters is the moment the last of it stops.
  useEffect(() => {
    let was = false;
    const read = () =>
      busyIn(useTabActivity.getState().running) ||
      useGenerate.getState().jobs.some((j) => j.status === "running") ||
      useEditor.getState().renders.some((r) => r.status === "running") ||
      useEditor.getState().subtitleStatus === "running" ||
      useExports.getState().local.length > 0 ||
      useExports.getState().jobs.some((j) => j.status === "queued" || j.status === "running");
    const apply = () => {
      const now = read();
      if (now === was) return;
      was = now;
      setBusy(now);
      // Starting clears the last finish; stopping is the finish.
      setDone(!now);
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
    const link = iconLink();
    const base = strip(document.title);
    if (!busy && !done) {
      document.title = base;
      link.href = link.dataset.rest || "/favicon.ico";
      return;
    }
    document.title = (busy ? BUSY_MARK : DONE_MARK) + base;
    if (!busy) {
      link.href = paint("done", 0);
      return;
    }
    let turn = 0;
    const step = () => {
      link.href = paint("busy", turn);
      turn += Math.PI / 5;
    };
    step();
    const timer = setInterval(step, SPIN_MS);
    return () => clearInterval(timer);
  }, [busy, done, projectName]);

  return null;
}
