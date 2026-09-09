let loaded: { projectId: string; revision: string } | null = null;

export function noteProjectRevision(projectId: string, revision: string | null): void {
  if (revision) loaded = { projectId, revision };
}

export function projectRevision(projectId: string): string | null {
  return loaded?.projectId === projectId ? loaded.revision : null;
}
