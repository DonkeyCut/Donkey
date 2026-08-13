"use client";

import { geminiModelRoles } from "@/lib/inference/gemini-models";
import { AI_SKILL_INDEX, AI_SKILLS } from "@/cut/server/ai/catalog";
import { buildAiContext } from "../aiContext";
import { runAiTool } from "../aiTools";
import { normalizeRef } from "../assetRef";
import { NO_CREDITS_MESSAGE, useGenerate } from "../generate";
import { hostedPost } from "../hosted";
import { refsToParts } from "../refMedia";
import { parkedTransitions, totalDuration, track0Clips, useEditor } from "../store";
import type { CutAgentDeps } from "./cutAgent";

const r1 = (x: number) => Math.round(x * 10) / 10;

/** The project's current debris, one line each: transition bars playing
 * nothing, and items stranded past the end of the video. */
function currentDebris(): string[] {
  const s = useEditor.getState();
  const lines: string[] = [];
  for (const t of parkedTransitions(s.clips, s.transitions)) {
    lines.push(
      `parked transition ${t.id} (${t.style}, ${r1(t.seconds)}s) at ${r1(t.start)}s — lines up with no cut, plays nothing`
    );
  }
  const end = totalDuration(track0Clips(s.clips));
  if (end > 0) {
    for (const o of s.overlays) {
      if (o.start >= end)
        lines.push(`overlay ${o.id} ("${"text" in o && o.text ? String(o.text).slice(0, 30) : o.kind}") starts at ${r1(o.start)}s, past the video's end at ${r1(end)}s`);
    }
    for (const a of s.audioClips) {
      if (a.start >= end)
        lines.push(`soundtrack clip ${a.id} starts at ${r1(a.start)}s, past the video's end at ${r1(end)}s`);
    }
  }
  return lines;
}

// The live editor's wiring for the pi chat loop. This module carries the
// browser-only graph (the editor store, hosted auth, media resolution), so
// cutAgent itself stays importable anywhere — the eval runs the same loop in
// Bun with its own deps.

export function productionDeps(): CutAgentDeps {
  return {
    post: (payload, signal) => hostedPost("/api/inference/responses", payload, signal),
    execTool: async (name, args) => {
      if (name === "list_skills") return { skills: AI_SKILL_INDEX };
      if (name === "read_skill") {
        const doc = AI_SKILLS[String(args.name ?? "")];
        if (!doc) throw new Error(`No such skill. Available: ${AI_SKILL_INDEX.join(", ")}`);
        return doc;
      }
      return runAiTool(name, args);
    },
    models: {
      simple: geminiModelRoles.chatSimple,
      complex: geminiModelRoles.chat,
      gate: geminiModelRoles.fastDecision,
    },
    buildContext: () => buildAiContext(),
    resolveRefs: async (meta) => {
      const refs = meta.map(normalizeRef).filter((r) => r !== null);
      return (await refsToParts(refs)).parts;
    },
    debris: currentDebris,
    onAuthFail: () => useGenerate.getState().probe(),
    noCreditsMessage: NO_CREDITS_MESSAGE,
    hooks: {
      onGate: (intent, ms, skipped) =>
        console.debug(`[chat] gate ${intent} ${Math.round(ms)}ms${skipped ? " skipped" : ""}`),
      onRound: (ms, firstDeltaMs) =>
        console.debug(
          `[chat] round ${Math.round(ms)}ms${firstDeltaMs === null ? "" : `, first delta ${Math.round(firstDeltaMs)}ms`}`
        ),
    },
  };
}
