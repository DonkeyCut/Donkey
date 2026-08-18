"use client";

import { useEffect, type ReactNode } from "react";

import { authHrefFor } from "@/app/_components/landing/useAppEntryHref";
import { setEngineUser } from "@/cut/lib/api";
import { useAppLoaded } from "@/lib/analytics";
import { authClient } from "@/lib/auth-client";

// Session gate for the whole Cut app surface. The landing CTAs already route
// signed-out clicks through /sign-in (useAppEntryHref); this covers direct
// navigation to an app URL the same way, sending the visitor to sign-in with
// the URL they wanted as the post-auth callback.
//
// It binds the account id and never holds the tree: the chrome around the
// content — the surface, the sidebar, the connect banner — is worth painting
// before a session exists, and it is what a cold load shows. What must wait is
// anything that reads the engine, because every engine URL carries the id, and
// SessionGate is where each surface waits for it.
export function RequireSession({ children }: { children: ReactNode }) {
  const { data: session, isPending } = authClient.useSession();

  const signedOut = !isPending && !session;
  const userId = session?.user.id;

  useAppLoaded("cut", session?.user);

  // Bound in an effect so the render stays free of side effects; SessionGate
  // subscribes to it, so the surfaces redraw the moment the id lands.
  useEffect(() => {
    if (userId) setEngineUser(userId);
  }, [userId]);

  useEffect(() => {
    if (!signedOut) return;
    const here = window.location.pathname + window.location.search;
    window.location.replace(authHrefFor("/sign-in", here));
  }, [signedOut]);

  return <>{children}</>;
}
