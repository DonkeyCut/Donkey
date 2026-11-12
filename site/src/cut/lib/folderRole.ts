/**
 * A folder some part of the app files into on its own, found by what it is
 * for rather than by its name: Home's drops land in Uploads. A role's folder
 * has an id derived from the role, so every writer converges on one folder
 * however many times it asks; past that it is an ordinary folder the person
 * can rename, fill, or delete.
 */
export const FOLDER_ROLES = ["uploads"] as const;
export type FolderRole = (typeof FOLDER_ROLES)[number];

export const isFolderRole = (v: unknown): v is FolderRole =>
  typeof v === "string" && (FOLDER_ROLES as readonly string[]).includes(v);

/** A role folder's id on a shelf of this machine: this browser's store or
 * the Mac's library. The shelf rides in the id so the two never share one
 * when a listing shows both; the cloud's carries the account id instead. */
export const roleFolderId = (role: FolderRole, shelf: "browser" | "mac"): string => `${role}-${shelf}`;
