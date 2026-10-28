"use client";

import { createAuthClient } from "better-auth/react";
import { useSyncExternalStore } from "react";

export const authClient = createAuthClient();

// Nothing to subscribe to: the answer only changes from server to client.
const subscribeNothing = () => () => {};

/**
 * The session as a component renders it. The server knows no session, so its
 * HTML is the pending state, and so is the client's first render: the session
 * check starts with the page and can answer before a section hydrates, which
 * would otherwise render a different tree over the server's (React #418).
 * The resolved session lands in the commit after hydration.
 */
export function useSession(): ReturnType<typeof authClient.useSession> {
  const live = authClient.useSession();
  const hydrated = useSyncExternalStore(subscribeNothing, () => true, () => false);
  return hydrated ? live : { ...live, data: null, isPending: true };
}
