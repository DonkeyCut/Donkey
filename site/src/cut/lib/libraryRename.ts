"use client";

import { renameLibraryAsset, type LibraryAsset } from "./library";
import { freeItemName } from "./itemName";
import { isLinkedType, syncLinkedLibrary } from "./linkedLibrary";

/** Rename a Library file of any kind — the write the card and the assistant
 * both make — numbered clear of the other files' names. The shelf stores the
 * name, and a font or LUT menu picks it up. The cloud shelf writes it over a
 * clip's title too, so the card reads it there as well. Returns the name as
 * stored. */
export async function renameLibraryFile(
  asset: Pick<LibraryAsset, "id" | "type" | "residency">,
  raw: string,
  others: readonly Pick<LibraryAsset, "id" | "name">[],
): Promise<string> {
  const name = freeItemName(raw, others.filter((a) => a.id !== asset.id).map((a) => a.name));
  await renameLibraryAsset(asset.residency, asset.id, name);
  if (isLinkedType(asset.type)) void syncLinkedLibrary();
  return name;
}
