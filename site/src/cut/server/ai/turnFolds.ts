/** A composer message folded into a running engine turn. It resolves true
 * once the provider has taken it into the turn, false when the turn ended
 * first — the page then sends it as its own turn. */
export interface Fold {
  text: string;
  resolve: (taken: boolean) => void;
}

/**
 * The running turn's mailbox for folds. A turn runs as one or more provider
 * runs; the run that is listening gets each fold the moment it lands, and
 * folds that land between runs wait for the next one. Closing the inbox hands
 * every fold no run took back to the page.
 */
export class FoldInbox {
  private waiting: Fold[] = [];
  private listener: ((fold: Fold) => void) | null = null;
  private closed = false;

  push(text: string): Promise<boolean> {
    if (this.closed) return Promise.resolve(false);
    return new Promise((resolve) => {
      const fold = { text, resolve };
      if (this.listener) this.listener(fold);
      else this.waiting.push(fold);
    });
  }

  /** Hand every fold to `take` as it lands, starting with the waiting ones.
   * Returns the call that stops listening. */
  listen(take: (fold: Fold) => void): () => void {
    this.listener = take;
    for (const fold of this.waiting.splice(0)) take(fold);
    return () => {
      if (this.listener === take) this.listener = null;
    };
  }

  /** The folds waiting between runs. */
  take(): Fold[] {
    return this.waiting.splice(0);
  }

  close(): void {
    this.closed = true;
    this.listener = null;
    for (const fold of this.waiting.splice(0)) fold.resolve(false);
  }
}

const inboxes = new Map<string, FoldInbox>();
const keyFor = (projectId: string, threadId: string) => `${projectId}/${threadId}`;

/** The inbox for a turn that is starting; the caller closes it when the turn ends. */
export function openFoldInbox(projectId: string, threadId: string): { inbox: FoldInbox; close: () => void } {
  const key = keyFor(projectId, threadId);
  const inbox = new FoldInbox();
  inboxes.set(key, inbox);
  return {
    inbox,
    close: () => {
      inbox.close();
      if (inboxes.get(key) === inbox) inboxes.delete(key);
    },
  };
}

/** Fold a message into the thread's running turn; false when none is running. */
export function foldIntoTurn(projectId: string, threadId: string, text: string): Promise<boolean> {
  return inboxes.get(keyFor(projectId, threadId))?.push(text) ?? Promise.resolve(false);
}
