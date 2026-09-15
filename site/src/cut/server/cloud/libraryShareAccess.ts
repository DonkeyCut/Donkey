import type { ShareSettings } from "@/cut/lib/librarySharing";

export function libraryShareAccess(
  share: ShareSettings & { userId: string },
  user: { id: string; email: string; emailVerified: boolean } | null,
): 200 | 401 | 403 {
  if (share.access === "public") return 200;
  if (!user) return 401;
  if (user.id === share.userId) return 200;
  return user.emailVerified && share.emails.includes(user.email.trim().toLowerCase()) ? 200 : 403;
}

/** Walk only the requested folder's ancestors. Missing parents and cycles deny access. */
export async function sharedFolderTrail(
  rootId: string,
  folderId: string,
  read: (id: string) => Promise<{ id: string; name: string; parentId: string | null } | null>,
): Promise<{ id: string; name: string }[] | null> {
  const trail: { id: string; name: string }[] = [];
  const seen = new Set<string>();
  let id: string | null = folderId;
  while (id && !seen.has(id)) {
    seen.add(id);
    const folder = await read(id);
    if (!folder) return null;
    trail.push({ id: folder.id, name: folder.name });
    if (folder.id === rootId) return trail.reverse();
    id = folder.parentId;
  }
  return null;
}
