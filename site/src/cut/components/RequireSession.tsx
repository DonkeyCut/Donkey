"use client";

import { useQueryClient } from "@tanstack/react-query";
import { useEffect, type ReactNode } from "react";
import { useEnvironment } from "@/cut/lib/environment";
import { EmbeddedSignInFallback } from "@/cut/components/EmbeddedSignInFallback";
import { onOperationFailure } from "@/cut/lib/operationFailure";

import { authHrefFor } from "@/app/_components/landing/useAppEntryHref";
import {
  confirmEngineUser,
  forgetRememberedEngineUser,
  rememberedEngineUser,
  setEngineUser,
} from "@/cut/lib/api";
import { reportExposures, useAppLoaded } from "@/lib/analytics";
import { useSession } from "@/lib/auth-client";
import { useAccountConfig } from "@/queries/accountConfig";
import { prefetchIntroOffer } from "@/queries/billing";
import { useNoteOutboxSync } from "@/cut/hooks/useNoteOutboxSync";

// Session gate for the whole Cut app surface. The landing CTAs already route
// signed-out clicks through /sign-in (useAppEntryHref); this covers direct
// navigation to an app URL the same way, sending the visitor to sign-in with
// the URL they wanted as the post-auth callback.
//
// It binds the account id; SessionGate, one level in, is what holds the app
// until the id lands, because every engine URL carries it.
export function RequireSession({ children }: { children: ReactNode }) {
  const { data: session, isPending, refetch } = useSession();
  useNoteOutboxSync();

  const signedOut = !isPending && !session;
  const userId = session?.user.id;

  // Framed by the ChatGPT card, the page carries its own partitioned session;
  // a browser that dropped it renews it through the card's tool bridge.
  const { chatgpt: embedded } = useEnvironment();

  // A request refused for want of a session — the framed editor's cookie aged
  // out mid-edit, or a sign-out in another tab — asks for the session again,
  // so the gate below offers the reconnect or the sign-in. Refusals arrive in
  // bursts, one per request in flight; one ask answers them all.
  useEffect(() => {
    let asking = false;
    return onOperationFailure((failure) => {
      if (failure.code !== "authentication_required" || asking) return;
      asking = true;
      void refetch().finally(() => {
        asking = false;
      });
    });
  }, [refetch]);

  useAppLoaded("cut", session?.user);

  // The account's configuration — public settings after overrides and
  // experiments — fetched behind the first paint, once the session is known.
  // Reading it is exposure, reported after `identify` above has bound the id.
  const config = useAccountConfig({ enabled: Boolean(userId) });
  useEffect(() => {
    if (!userId || !config.data) return;
    reportExposures(config.data);
  }, [userId, config.data]);

  // The intro offer, loaded with the account so every card that sells Pro
  // has it on its first frame. Loading it starts no window.
  const queryClient = useQueryClient();
  useEffect(() => {
    if (!userId) return;
    void prefetchIntroOffer(queryClient);
  }, [userId, queryClient]);

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
    if (userId) confirmEngineUser(userId);
  }, [userId]);

  useEffect(() => {
    if (!signedOut || embedded) return;
    forgetRememberedEngineUser();
    const here = window.location.pathname + window.location.search;
    window.location.replace(authHrefFor("/sign-in", here));
  }, [signedOut, embedded]);

  if (signedOut && embedded) return <EmbeddedSignInFallback />;
  return <>{children}</>;
}
