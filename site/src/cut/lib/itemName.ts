/** The name a renamed item is stored under: trimmed and capped. Every shelf
 * and the project apply the same rule, so an item reads the same wherever it
 * lives. */
export function itemName(raw: unknown): string {
  const name = typeof raw === "string" ? raw.trim().slice(0, 80) : "";
  if (!name) throw new Error("Name required.");
  return name;
}

/** `itemName`, numbered clear of the names beside it — a prompt names an item
 * by its name, so two alike would point at one of them. The numbering is the
 * one an import takes: `clip-1.mp4`. */
export function freeItemName(raw: unknown, taken: Iterable<string>): string {
  const name = itemName(raw);
  const used = new Set([...taken].map((t) => t.toLowerCase()));
  const ext = /\.[a-z0-9]{1,5}$/i.exec(name)?.[0] ?? "";
  const stem = name.slice(0, name.length - ext.length);
  let next = name;
  for (let n = 1; used.has(next.toLowerCase()); n++) next = `${stem}-${n}${ext}`;
  return next;
}
