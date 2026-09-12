/** One SDK request owns a thread until its finish callback has returned. */
export class ChatRequests {
  private pending = false;
  private listeners = new Set<() => void>();

  snapshot = (): boolean => this.pending;
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };

  private publish(pending: boolean): void {
    this.pending = pending;
    for (const listener of this.listeners) listener();
  }

  async run(request: () => Promise<void>): Promise<boolean> {
    if (this.pending) return false;
    this.publish(true);
    try {
      await request();
      return true;
    } finally {
      this.publish(false);
    }
  }
}
