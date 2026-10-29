"use client";

import { DonkeyMark } from "@/components/DonkeyMark";
import { useState } from "react";
import { useTranslations } from "next-intl";
import { useDescribeError } from "@/i18n/describeError";
import { Copy, Loader2, Sparkles } from "lucide-react";
import { authHrefFor } from "@/app/_components/landing/useAppEntryHref";
import { ChatStatusBadge, type ChatStatus } from "./ChatStatusBadge";
import { Button } from "@/components/ui/button";
import { apiFetch } from "@/cut/lib/backend";
import { projectHref, useCutBase } from "@/cut/lib/nav";
import { OperationError, operationFailure } from "@/cut/lib/operationFailure";
import { useEditor } from "@/cut/lib/store";
import { tourHoldsProjects } from "@/cut/lib/tourLock";
import { errorFromBody } from "@/cut/lib/userError";
import { useSession } from "@/lib/auth-client";

// Chrome for the read-only share view: logo, project name, a "View only"
// chip, and the viewer's two actions — open the shared chat (when the share
// includes it) and copy the project into their own account. Copying needs a
// session: signed-out clicks route through sign-in with this share URL as the
// callback.
export function ViewerTopBar({ chatStatus }: { chatStatus: ChatStatus }) {
  const t = useTranslations("editor.viewerTopBar");
  const describeError = useDescribeError();
  const aiOpen = useEditor((s) => s.aiOpen);
  const base = useCutBase();
  const projectName = useEditor((s) => s.projectName);
  const chatShared = useEditor((s) => s.sharedFeatures?.chat === true);
  const { data: session } = useSession();
  const [copying, setCopying] = useState(false);
  const [copyError, setCopyError] = useState<string | null>(null);

  const copyProject = async () => {
    if (!session) {
      const here = window.location.pathname + window.location.search;
      window.location.href = authHrefFor("/sign-in", here);
      return;
    }
    // A copy is a new project, and the starter tour holds those.
    if (tourHoldsProjects()) {
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
        // A refusal with a code (a full cloud quota) reads in the page's language.
        const failure = operationFailure(res.status, body);
        if (failure?.code === "storage_quota_exceeded") {
          throw new OperationError(failure);
        }
        throw errorFromBody(body, t("copyFailed"));
      }
      // Copies drain through a queue one at a time; poll the job until this
      // one lands.
      for (;;) {
        await new Promise((r) => setTimeout(r, 2000));
        const st = await apiFetch(`/api/cut/copy/${body.jobId}`);
        if (!st.ok) throw new Error(t("copyFailed"));
        const job = (await st.json()) as {
          state: string;
          newProjectId?: string;
          error?: string;
        };
        if (job.state === "done" && job.newProjectId) {
          window.location.href = projectHref(base, job.newProjectId, "projects");
          return;
        }
        if (job.state === "error") throw errorFromBody(job, t("copyFailed"));
      }
    } catch (e) {
      setCopyError(describeError(e, t("copyFailed")));
      setCopying(false);
    }
  };

  return (
    <header className="relative flex items-center justify-between border-b border-border bg-card pr-3 pl-3">
      <div className="flex min-w-0 items-center gap-1">
        <span className="grid size-[22px] shrink-0 place-items-center">
          <DonkeyMark alt="Donkey" />
        </span>
        <span className="ml-1.5 max-w-64 truncate px-2 py-1 text-sm font-medium tracking-tight">
          {projectName}
        </span>
        <span className="ml-1 rounded-full border border-border px-2 py-0.5 text-[10.5px] font-medium text-muted-foreground">
          {t("viewOnly")}
        </span>
      </div>
      <div className="flex items-center gap-2">
        {copyError && <span className="max-w-72 truncate text-xs text-destructive">{copyError}</span>}
        {chatShared && (
          <Button
            variant="ghost"
            size="sm"
            className="ai-toggle relative"
            aria-label={t("chat")}
            title={t("chatShortcut", { key: "⌘J" })}
            onClick={() => {
              const s = useEditor.getState();
              s.setAiOpen(!s.aiOpen);
            }}
          >
            <Sparkles data-icon="inline-start" /> {t("chat")}
            {!aiOpen && <ChatStatusBadge status={chatStatus} />}
          </Button>
        )}
        <Button size="sm" disabled={copying} onClick={() => void copyProject()}>
          {copying ? (
            <Loader2 className="animate-spin" data-icon="inline-start" />
          ) : (
            <Copy data-icon="inline-start" />
          )}
          {copying ? t("copying") : t("copyProject")}
        </Button>
      </div>
    </header>
  );
}
