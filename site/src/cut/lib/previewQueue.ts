/** A host owns lifecycle signals; this queue owns coalescing and completion. */
export type PreviewState<R> =
  | { status: "idle" | "queued" | "running" }
  | { status: "done"; result: R }
  | { status: "error"; error: unknown };

export function createPreviewQueue<T, R>(
  render: (input: T) => Promise<R>,
  minimumGapMs: number,
  onChange: (state: PreviewState<R>) => void = () => {}
) {
  let pending: { input: T; sequence: number } | null = null;
  let sequence = 0;
  let running: Promise<void> | null = null;
  let drain = false;
  let lastRun = -Infinity;
  let state: PreviewState<R> = { status: "idle" };
  const publish = (next: PreviewState<R>) => { state = next; onChange(next); };
  const flush = (final = false): Promise<void> => {
    drain ||= final;
    if (running) return running;
    if (!pending) { drain = false; return Promise.resolve(); }
    if (!drain && Date.now() - lastRun < minimumGapMs) return Promise.resolve();
    running = (async () => {
      do {
        const next = pending!;
        pending = null;
        lastRun = Date.now();
        publish({ status: "running" });
        try {
          const result = await render(next.input);
          if (next.sequence === sequence) publish({ status: "done", result });
        } catch (error) {
          if (next.sequence === sequence) publish({ status: "error", error });
        }
      } while (drain && pending);
    })().finally(() => { running = null; drain = false; });
    return running;
  };
  return {
    stage(input: T) { pending = { input, sequence: ++sequence }; publish({ status: "queued" }); },
    flush,
    getState: () => state,
  };
}
