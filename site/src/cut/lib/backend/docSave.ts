/**
 * What a project save carries. Opening a project runs analysis over its
 * media — speech, beats, scene cuts, color, proxies — and the editor saves
 * those results like any change. They are not the person's edits, so such a
 * save says "settle", and the project keeps the time it was last edited.
 * A save with no marker (a headless job, an older page) is an edit.
 */
export const DOC_SAVE_HEADER = "x-cut-doc-save";

export type DocSave = "edit" | "settle";

/** The kind of save a request carries. */
export function docSaveOf(req: Request): DocSave {
  return req.headers.get(DOC_SAVE_HEADER) === "settle" ? "settle" : "edit";
}

/** The project's edited time after a save: a settle keeps the one it had. */
export function savedAt(save: DocSave, previous: number | undefined, now: number): number {
  if (save === "settle" && previous !== undefined) {
    return previous;
  }
  return now;
}
