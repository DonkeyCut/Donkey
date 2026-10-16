// Chat history a deleted project left in this browser is swept once every live
// residency has listed for the account the session confirmed. A listing
// fetched under the remembered last account, before the session resolves,
// can be another account's shelf (the browser store and the engine read by
// the bound id), so it never decides which threads are whose.
import type { Residency } from "./residency";

type SweepDeps = {
  residencies: () => Residency[];
  /** The account the live session named; null until it resolves. */
  confirmed: () => string | null;
  sweep: (listed: Set<string>, account: string) => Promise<void>;
};

export function listingSweeper({ residencies, confirmed, sweep }: SweepDeps) {
  // Each residency's latest listing and the account bound when it was fetched.
  const listings = new Map<Residency, { ids: Set<string>; as: string | null }>();

  // Sweep only when every live residency listed as the confirmed account.
  const retry = () => {
    const account = confirmed();
    if (!account) return;
    const live = residencies();
    if (!live.every((r) => listings.get(r)?.as === account)) return;
    const listed = new Set(live.flatMap((r) => [...listings.get(r)!.ids]));
    void sweep(listed, account);
  };

  return {
    note(r: Residency, ids: Set<string>, as: string | null) {
      listings.set(r, { ids, as });
      retry();
    },
    retry,
  };
}
