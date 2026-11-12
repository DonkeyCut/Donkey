// The cloud's Assets folders: one tree per account holding projects, library
// files, templates and placed notes alike. Note folders (scope "note") are the
// phone's own tree and stay out of it.
import type { FolderRole } from "@/cut/lib/folderRole";

/** The CutFolder scopes that form the Assets tree. "project" rows are folders
 * made before projects and files shared one tree; nothing writes that scope
 * any more, and every read and check takes both. */
export const ASSET_FOLDER_SCOPES = ["library", "project"] as const;

/** The scope a new Assets folder is written with. */
export const ASSET_FOLDER_SCOPE = "library";

/** The Prisma filter for a row in the Assets tree. */
export const assetFolderScope = { in: [...ASSET_FOLDER_SCOPES] };

/** A role folder's id: derived from the account, so every writer converges
 * on one row (the pattern Inspiration and Fonts follow). */
export const roleFolderIdOf = (role: FolderRole, userId: string) => `${role}-${userId}`;
