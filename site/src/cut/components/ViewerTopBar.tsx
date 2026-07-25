"use client";

import { useState } from "react";
import { Copy, Loader2, Sparkles } from "lucide-react";
import { authHrefFor } from "@/app/_components/landing/useAppEntryHref";
import { Button } from "@/components/ui/button";
import { apiFetch } from "@/cut/lib/backend";
import { quotaErrorMessage } from "@/cut/lib/backend/cloud";
import { enableWebMode } from "@/cut/lib/flags";
import { projectHref, useCutBase } from "@/cut/lib/nav";
import { useEditor } from "@/cut/lib/store";
import { authClient } from "@/lib/auth-client";

// Chrome for the read-only share view: logo, project name, a "View only"
// chip, and the viewer's two actions — open the shared chat (when the share
// includes it) and copy the project into their own account. Copying needs a
// session: signed-out clicks route through sign-in with this share URL as the
// callback.
export function ViewerTopBar() {
  const base = useCutBase();
  const projectName = useEditor((s) => s.projectName);
  const chatShared = useEditor((s) => s.sharedFeatures?.chat === true);
  const { data: session } = authClient.useSession();
  const [copying, setCopying] = useState(false);
  const [copyError, setCopyError] = useState<string | null>(null);

  const copyProject = async () => {
    if (!session) {
      const here = window.location.pathname + window.location.search;
      window.location.href = authHrefFor("/sign-in", here);
      return;
    }
    setCopying(true);
    setCopyError(null);
    try {
      const res = await apiFetch("/api/cut/copy", { method: "POST" });
      const body = (await res.json().catch(() => null)) as
        | { jobId?: string; error?: string }
        | null;
      if (!res.ok || !body?.jobId) {
        throw new Error(
          quotaErrorMessage(res.status, body) ?? body?.error ?? "Could not copy the project."
        );
      }
      // Copies drain through a queue one at a time; poll the job until this
      // one lands.
      for (;;) {
        await new Promise((r) => setTimeout(r, 2000));
        const st = await apiFetch(`/api/cut/copy/${body.jobId}`);
        if (!st.ok) throw new Error("Could not copy the project.");
        const job = (await st.json()) as {
          state: string;
          newProjectId?: string;
          error?: string;
        };
        if (job.state === "done" && job.newProjectId) {
          // The copy is a cloud project, so cloud editing must be on for
          // this account before the editor opens it.
          await enableWebMode();
          window.location.href = projectHref(base, job.newProjectId, "projects");
          return;
        }
        if (job.state === "error") throw new Error(job.error ?? "Could not copy the project.");
      }
    } catch (e) {
      setCopyError(e instanceof Error ? e.message : "Could not copy the project.");
      setCopying(false);
    }
  };

  return (
    <header className="relative flex items-center justify-between border-b border-border bg-card pr-3 pl-3">
      <div className="flex min-w-0 items-center gap-1">
        <span className="grid size-[22px] shrink-0 place-items-center">
          <img
            src="/donkey-logo.svg"
            alt="Donkey"
            width={22}
            height={22}
            className="block h-full w-full object-contain"
          />
        </span>
        <span className="ml-1.5 max-w-64 truncate px-2 py-1 text-sm font-medium tracking-tight">
          {projectName}
        </span>
        <span className="ml-1 rounded-full border border-border px-2 py-0.5 text-[10.5px] font-medium text-muted-foreground">
          View only
        </span>
      </div>
      <div className="flex items-center gap-2">
        {copyError && <span className="max-w-72 truncate text-xs text-destructive">{copyError}</span>}
        {chatShared && (
          <Button
            variant="ghost"
            size="sm"
            className="ai-toggle"
            aria-label="Chat"
            title="Chat (⌘J)"
            onClick={() => {
              const s = useEditor.getState();
              s.setAiOpen(!s.aiOpen);
            }}
          >
            <Sparkles data-icon="inline-start" /> Chat
          </Button>
        )}
        <Button size="sm" disabled={copying} onClick={() => void copyProject()}>
          {copying ? (
            <Loader2 className="animate-spin" data-icon="inline-start" />
          ) : (
            <Copy data-icon="inline-start" />
          )}
          {copying ? "Copying…" : "Copy project"}
        </Button>
      </div>
    </header>
  );
}
