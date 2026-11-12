"use client";

import { useSearchParams } from "next/navigation";
import { LegacyAssetsRedirect } from "./LegacyAssetsRedirect";

/** Projects folders used to open on the app's root (`/app?folder=…`). Folders
 * live in Assets now, so an address naming one goes there. */
export function HomeFolderRedirect() {
  const folder = useSearchParams().get("folder");
  return folder ? <LegacyAssetsRedirect /> : null;
}
