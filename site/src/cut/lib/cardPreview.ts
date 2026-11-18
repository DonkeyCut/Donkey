import type { CutBackend } from "./backend/types";

/** What every backend answers for a project with no rendered card. */
const NOT_FOUND = 404;

/** Whether a project's card (its rendered preview.mp4) exists on its backend.
 * The cloud answers with a redirect to signed storage, so the redirect is the
 * yes and the bytes never cross. Any other answer counts as present: a
 * backend that fails the probe should not also be handed a render. */
export async function hasCardPreview(
  backend: Pick<CutBackend, "fetch">,
  projectId: string,
): Promise<boolean> {
  const res = await backend.fetch(
    `/api/cut/projects/${encodeURIComponent(projectId)}/preview`,
    {
      redirect: "manual",
      observe: true,
    },
  );
  void res.body?.cancel();
  return res.status !== NOT_FOUND;
}
