import type { AiToolDef } from "@/cut/lib/aiToolDef";
import { AI_TOOLS, areaTools, CORE_TOOLS, REQUEST_TOOLS_DEF, TOOL_AREA_NAMES } from "./catalog";

// The tools one engine chat turn declares. The page judges a Claude or Codex
// turn the way it judges a Gemini one and sends the route with the request;
// the MCP proxy lists this turn's catalog, a call outside it is refused, and
// `request_tools` widens it. A turn sent without a route (no credits to judge
// with, or an older page) declares the whole catalog and the model decides.

/** The judged route an engine turn carries. Mirrors the page's TurnRoute. */
export interface EngineRoute {
  intent: "chat" | "simple" | "complex";
  areas: string[];
  /** The skill to attach: a name, null for none, absent when skill
   * suggestion is off. */
  skill?: string | null;
  /** The page answers the quality gate when the turn signs off. */
  gate: boolean;
}

/** An ask the page settled to one known action and ran with no model round,
 * reported to the provider's session on its next turn. */
export interface HandledAsk {
  ask: string;
  tool: string;
  args: unknown;
  say: string;
}

/** How the provider picks up a widened catalog. Claude refreshes its listing
 * on the proxy's list_changed notice; Codex reads it once per run, so the
 * turn resumes in a fresh run to see the new tools. */
export type CatalogRefresh = "live" | "next-run";

interface TurnTools {
  /** The declared areas; null declares the whole catalog. */
  areas: Set<string> | null;
  /** A chat verdict: no editor tool at all. */
  chat: boolean;
  refresh: CatalogRefresh;
  /** Areas added since the last run started. */
  widened: boolean;
}

// A chat turn keeps only the skill readers: they run in the engine, change
// nothing, and keep the editor server bound for a session that resumes with
// tool calls in its history.
const CHAT_TOOLS = new Set(["list_skills", "read_skill"]);

// Survives dev-server module reloads.
const g = globalThis as unknown as { __cutTurnTools?: Map<string, TurnTools> };
const turns = (g.__cutTurnTools ??= new Map<string, TurnTools>());

/** Record the catalog a chat session's turn declares. */
export function declareTurn(sessionKey: string, route: EngineRoute | undefined, refresh: CatalogRefresh): void {
  const areas = route && route.intent !== "chat" ? new Set(route.areas.filter((a) => TOOL_AREA_NAMES.includes(a))) : null;
  turns.set(sessionKey, { areas, chat: route?.intent === "chat", refresh, widened: false });
}

export function dropTurn(sessionKey: string): void {
  turns.delete(sessionKey);
}

/** The MCP listing for a session: the whole catalog for an unrouted turn,
 * the core plus its areas (and the escape hatch) for a routed one. */
export function turnTools(sessionKey: string | null): AiToolDef[] {
  const turn = sessionKey ? turns.get(sessionKey) : undefined;
  if (!turn) return AI_TOOLS;
  if (turn.chat) return AI_TOOLS.filter((t) => CHAT_TOOLS.has(t.name));
  if (!turn.areas || turn.areas.size === TOOL_AREA_NAMES.length) return AI_TOOLS;
  const names = new Set([...CORE_TOOLS, ...areaTools(turn.areas)].map((t) => t.name));
  return [...AI_TOOLS.filter((t) => names.has(t.name)), REQUEST_TOOLS_DEF];
}

/** Whether the session's turn declares the tool. */
export function declaresTool(sessionKey: string, name: string): boolean {
  return turnTools(sessionKey).some((t) => t.name === name);
}

/** Add the asked areas to the session's turn. Returns the result the model
 * reads: what was added, the tool names, and when they arrive. */
export function widenTurn(sessionKey: string, asked: unknown): { added: string[]; tools: string[]; note: string } {
  const turn = turns.get(sessionKey);
  const wanted = Array.isArray(asked) ? asked : [];
  const added = !turn?.areas
    ? []
    : wanted.filter((a): a is string => typeof a === "string" && TOOL_AREA_NAMES.includes(a) && !turn.areas!.has(a));
  for (const a of added) turn!.areas!.add(a);
  if (added.length > 0) turn!.widened = true;
  const note =
    added.length === 0
      ? "Nothing to add: those areas are already declared."
      : turn!.refresh === "live"
        ? "Available from your next step."
        : "Declared from the next run: end this step with one short line and the turn resumes with them.";
  return { added, tools: areaTools(added).map((t) => t.name), note };
}

/** True once per widening, for a provider that reads its catalog per run:
 * the turn resumes so the new tools are listed. */
export function takeWidened(sessionKey: string): boolean {
  const turn = turns.get(sessionKey);
  if (!turn?.widened || turn.refresh !== "next-run") return false;
  turn.widened = false;
  return true;
}
