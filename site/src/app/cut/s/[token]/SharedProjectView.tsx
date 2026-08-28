"use client";

import { Suspense, useEffect, useState } from "react";
import { useParams } from "next/navigation";
import { Clapperboard, Loader2 } from "lucide-react";
import { authHrefFor } from "@/app/_components/landing/useAppEntryHref";
import { Button } from "@/components/ui/button";
import { Editor } from "@/cut/components/Editor";
import { MobileShare } from "@/cut/components/share/MobileShare";
import { useIsNarrowAtOpen } from "@/cut/hooks/useIsNarrow";
import { bindCutMode } from "@/cut/lib/backend";
import { bindSharedBackend } from "@/cut/lib/backend/shared";
import { holdThreadsInMemory } from "@/cut/lib/chatThreads";
import { useEditor } from "@/cut/lib/store";
import type { ShareFeatures } from "@/cut/lib/types";
import { authClient } from "@/lib/auth-client";

// The read-only share view. This route sits beside the app subtree on purpose:
// /cut/app is session-gated (RequireSession) and engine-gated (ConnectGate),
// and a public share link must open with neither. The share meta fetch is the
// access check — the server answers 401 (sign in), 403 (not invited), or 404
// (no such share) — and on success the page binds the shared backend and
// mounts the editor in viewer mode.

type Gate =
  | { state: "loading" }
  | { state: "ready"; projectId: string; name: string; features: ShareFeatures }
  | { state: "signin" }
  | { state: "denied" }
  | { state: "missing" };

export function SharedProject() {
  const { token } = useParams<{ token: string }>();
  const [gate, setGate] = useState<Gate>({ state: "loading" });
  const { data: session } = authClient.useSession();
  const narrow = useIsNarrowAtOpen();

  useEffect(() => {
    let alive = true;
    void fetch(`/api/cut-shared/${encodeURIComponent(token)}`)
      .then(async (res) => {
        if (!alive) return;
        if (res.status === 401) return setGate({ state: "signin" });
        if (res.status === 403) return setGate({ state: "denied" });
        if (!res.ok) return setGate({ state: "missing" });
        const meta = (await res.json()) as {
          projectId: string;
          name?: string;
          features: ShareFeatures;
        };
        bindSharedBackend(token);
        bindCutMode("shared");
        holdThreadsInMemory();
        useEditor.getState().setSharedView(meta.features);
        setGate({
          state: "ready",
          projectId: meta.projectId,
          name: meta.name ?? "Untitled",
          features: meta.features,
        });
      })
      .catch(() => alive && setGate({ state: "missing" }));
    return () => {
      alive = false;
    };
  }, [token]);

  // A phone gets the player, not the editor. The choice is made here rather
  // than in CSS because the editor starts a decoder per clip the moment it
  // mounts, which is the cost a narrow screen cannot pay — so the render waits
  // for `narrow` to be known rather than guessing and correcting.
  if (gate.state === "ready" && narrow !== null) {
    return narrow ? (
      <MobileShare
        token={token}
        projectId={gate.projectId}
        name={gate.name}
        features={gate.features}
      />
    ) : (
      <Editor projectId={gate.projectId} viewer />
    );
  }

  if (gate.state === "loading" || gate.state === "ready") {
    return (
      <div className="grid h-[100dvh] place-items-center text-muted-foreground">
        <Loader2 className="size-5 animate-spin" />
      </div>
    );
  }

  const signIn = () => {
    const here = window.location.pathname + window.location.search;
    window.location.href = authHrefFor("/sign-in", here);
  };

  return (
    <div className="grid h-[100dvh] place-items-center">
      <div className="flex max-w-sm flex-col items-center gap-3 text-center">
        <Clapperboard className="size-7 text-muted-foreground" />
        {gate.state === "signin" ? (
          <>
            <p className="text-sm text-muted-foreground">
              This project is shared with specific people — sign in to see if
              that&apos;s you.
            </p>
            <Button onClick={signIn}>Sign in</Button>
          </>
        ) : gate.state === "denied" ? (
          <p className="text-sm text-muted-foreground">
            You don&apos;t have access to this project
            {session?.user.email ? ` as ${session.user.email}` : ""}. Ask the
            owner to invite you.
          </p>
        ) : (
          <p className="text-sm text-muted-foreground">
            This share link isn&apos;t active anymore.
          </p>
        )}
      </div>
    </div>
  );
}

export function SharedProjectView() {
  // Dynamic viewport units, not h-screen: on a phone the browser's own chrome
  // slides in and out, and 100vh measures the tallest state — so the bottom of
  // a fixed-height page sits under the toolbar for most of a visit.
  //
  // `app-surface` is what repoints --background to the product white for the
  // whole document (see globals.css). A share mounts the editor, so it needs
  // the same surface the app runs on: without it every bg-background control
  // inside — the preview's zoom pill, the panel chrome — resolves against the
  // cream landing token and the viewer sees a beige editor on a white page.
  return (
    <div className="app-surface h-[100dvh] bg-white font-system text-foreground antialiased">
      <Suspense>
        <SharedProject />
      </Suspense>
    </div>
  );
}
