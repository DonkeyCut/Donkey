export class SceneOwnedElsewhere extends Error {
  constructor() { super("This video is already working in another tab. Its progress will appear here."); }
}

/** Keep the lease until its last renewal and the operation have both settled. */
export async function withSceneLease<T>(
  lease: (release?: boolean) => Promise<boolean>,
  work: () => Promise<T>,
  lost: () => void,
  intervalMs: number | (() => number),
): Promise<T> {
  if (!(await lease())) throw new SceneOwnedElsewhere();
  let stopped = false;
  let renewal: Promise<void> = Promise.resolve();
  let timer: ReturnType<typeof setTimeout>;
  let lostLease = false;
  const renew = async () => {
    try { lostLease = !(await lease()); } catch { lostLease = true; }
    if (lostLease) lost();
    else if (!stopped) schedule();
  };
  const schedule = () => { timer = setTimeout(() => { renewal = renew(); }, typeof intervalMs === "function" ? intervalMs() : intervalMs); };
  schedule();
  try {
    const result = await work();
    if (lostLease) throw new SceneOwnedElsewhere();
    return result;
  } finally {
    stopped = true;
    clearTimeout(timer!);
    await renewal;
    await lease(true);
  }
}
