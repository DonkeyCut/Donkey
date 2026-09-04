"use client";

import { useEffect, type ReactNode } from "react";

import { authHrefFor } from "@/app/_components/landing/useAppEntryHref";
import {
  forgetRememberedEngineUser,
  rememberedEngineUser,
  setEngineUser,
} from "@/cut/lib/api";
import { reportExposures, useAppLoaded } from "@/lib/analytics";
import { authClient } from "@/lib/auth-client";
import { useAccountConfig } from "@/queries/accountConfig";

// Session gate for the whole Cut app surface. The landing CTAs already route
// signed-out clicks through /sign-in (useAppEntryHref); this covers direct
// navigation to an app URL the same way, sending the visitor to sign-in with
// the URL they wanted as the post-auth callback.
//
// It binds the account id; SessionGate, one level in, is what holds the app
// until the id lands, because every engine URL carries it.
export function RequireSession({ children }: { children: ReactNode }) {
  const { data: session, isPending } = authClient.useSession();

  const signedOut = !isPending && !session;
  const userId = session?.user.id;

  useAppLoaded("cut", session?.user);

  // The account's configuration — public settings after overrides and
  // experiments — fetched behind the first paint, once the session is known.
  // Reading it is exposure, reported after `identify` above has bound the id.
  const config = useAccountConfig({ enabled: Boolean(userId) });
  useEffect(() => {
    if (!userId || !config.data) return;
    reportExposures(config.data);
  }, [userId, config.data]);

  // Paint first, verify behind: the account remembered from the last visit
  // opens the gate immediately, so a reload shows cached shelves while the
  // session request is still in flight. The resolved session overrides it —
  // a different account re-binds, a signed-out visitor is redirected. Ordered
  // before the live binding below so a session that resolved during hydration
  // wins on the same commit.
  useEffect(() => {
    const remembered = rememberedEngineUser();
    if (remembered) setEngineUser(remembered);
  }, []);

  // Bound in an effect so the render stays free of side effects; SessionGate
  // subscribes to it, so the surfaces redraw the moment the id lands.
  useEffect(() => {
    if (userId) setEngineUser(userId);
  }, [userId]);

  useEffect(() => {
    if (!signedOut) return;
    forgetRememberedEngineUser();
    const here = window.location.pathname + window.location.search;
    window.location.replace(authHrefFor("/sign-in", here));
  }, [signedOut]);

  return <>{children}</>;
}
