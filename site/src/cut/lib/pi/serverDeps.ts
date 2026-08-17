import { geminiModelRoles } from "@/lib/inference/gemini-models";
import { AI_SKILL_INDEX, AI_SKILLS } from "@/cut/server/ai/catalog";
import { buildAiContext } from "../aiContext";
import { runAiTool, UI_TOOLS } from "../aiTools";
import { normalizeRef } from "../assetRef";
import { NO_CREDITS_MESSAGE } from "../generate";
import { hostedPost } from "../hosted";
import { bindHeadlessSession, type HeadlessSession } from "../headless/bind";
import { refsToParts } from "../refMedia";
import type { CutAgentDeps } from "./cutAgent";
import { currentDebris } from "./debris";

// The headless wiring for the pi chat loop. The runner opens a project into
// the store (openProjectDoc), runs the turn with these deps, and pushes the
// doc back up. Every transport rides the session's origin and auth headers.

export type { HeadlessSession };

export function headlessDeps(session: HeadlessSession): CutAgentDeps {
  bindHeadlessSession(session);
  return {
    post: (payload, signal) => hostedPost("/api/inference/responses", payload, signal),
    execTool: async (name, args) => {
      if (name === "list_skills") return { skills: AI_SKILL_INDEX };
      if (name === "read_skill") {
        const doc = AI_SKILLS[String(args.name ?? "")];
        if (!doc) throw new Error(`No such skill. Available: ${AI_SKILL_INDEX.join(", ")}`);
        return doc;
      }
      if (UI_TOOLS.has(name))
        return {
          noEditor: true,
          note: "No editor page is attached to this session, so this tool had no effect. The project itself is unchanged — keep working from the editor state.",
        };
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
    noCreditsMessage: NO_CREDITS_MESSAGE,
  };
}
