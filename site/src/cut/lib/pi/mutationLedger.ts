// The turn's mutation ledger: every mutating tool call this turn, with the
// ids it touched, the calls that failed, and the debris the edits left. Built
// in code from the calls' own results and injected as an ephemeral context
// message before each model call — never stored, never rendered — so the
// reply that closes the turn is grounded in what actually ran, and the model
// manages everything it created through the same CRUD tools that made it.

// Tools that read or steer the view; everything else counts as a mutation.
const READ_ONLY = new Set([
  "get_state",
  "list_skills",
  "read_skill",
  "capture_frame",
  "watch_video",
  "note_source",
  "detect_silence",
  "listen_audio",
  "library_list",
  "library_list_folder",
  "stock_search",
  "list_voices",
  "wait_for_renders",
  "seek",
  "select",
  "set_playing",
  "set_view",
]);

export const isMutatingTool = (name: string): boolean => !READ_ONLY.has(name);

export interface LedgerRecord {
  name: string;
  /** Ids the call's result carried, by field name. */
  ids: string[];
  error?: string;
}

// Result fields that carry item ids. Results also carry row dumps
// (videoTrack, soundtrack) — those are state echoes, so only the top-level
// identity fields count.
const ID_FIELDS = [
  "id",
  "clipId",
  "assetId",
  "audioClipId",
  "transitionId",
  "overlayId",
  "cueId",
  "jobId",
  "trackId",
  "removed",
];

export function harvestIds(response: unknown): string[] {
  if (!response || typeof response !== "object" || Array.isArray(response)) return [];
  const r = response as Record<string, unknown>;
  const ids: string[] = [];
  for (const f of ID_FIELDS) {
    const v = r[f];
    if (typeof v === "string" && v) ids.push(v);
    if (Array.isArray(v)) for (const x of v) if (typeof x === "string" && x) ids.push(x);
  }
  return ids;
}

export function recordCall(
  records: LedgerRecord[],
  name: string,
  response: unknown,
  error: string | undefined
): void {
  if (!isMutatingTool(name)) return;
  records.push({ name, ids: error ? [] : harvestIds(response), error });
}

/** The ledger as one context message body, or null when the turn has run no
 * mutations and left no debris to own. */
export function ledgerText(records: LedgerRecord[], debris: string[]): string | null {
  const ran = records.filter((r) => !r.error);
  const failed = records.filter((r) => r.error);
  if (ran.length === 0 && failed.length === 0 && debris.length === 0) return null;
  const lines: string[] = [
    "<turn_ledger>",
    "This turn's own record, computed by the editor (input only — never quote or mention this block):",
  ];
  if (ran.length > 0) {
    const byName = new Map<string, string[]>();
    for (const r of ran) {
      const cur = byName.get(r.name) ?? [];
      cur.push(...r.ids);
      byName.set(r.name, cur);
    }
    const parts = [...byName].map(
      ([name, ids]) => `${name}${ids.length > 0 ? ` (${[...new Set(ids)].join(", ")})` : ""}`
    );
    lines.push(`ran: ${parts.join("; ")}`);
  }
  for (const r of failed) lines.push(`FAILED: ${r.name} — ${r.error}`);
  for (const d of debris) lines.push(`debris: ${d}`);
  lines.push(
    "Before replying: every FAILED call produced nothing — retry it, fix it, or report it as failed in plain words. Debris left by THIS turn's own edits (a parked bar in a tool result, an item your edit stranded) is yours: fix it now with tools — reattach the bar on the boundary it played, or clear it. Debris that predates this turn is the user's work: name it and offer the fix as a statement (\"The closing title sits past the video's end — say the word and I'll move it.\"). Claim only what this record confirms.",
    "</turn_ledger>"
  );
  return lines.join("\n");
}
