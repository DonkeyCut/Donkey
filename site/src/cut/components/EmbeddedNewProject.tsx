"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useQueryClient } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { creatorNames } from "@/cut/lib/defaultNames";

import { Button } from "@/components/ui/button";
import { cloudBackend } from "@/cut/lib/backend/cloud";
import { seedNewProjectDoc } from "@/cut/lib/docCache";
import { framedHref } from "@/cut/lib/hostBridge";
import { projectHref, useCutBase } from "@/cut/lib/nav";
import { newProjectAllowed } from "@/cut/lib/projectLimit";
import { lastChosenAspect } from "@/cut/lib/store";
import type { ProjectSummary } from "@/cut/lib/types";
import { errorFromBody } from "@/cut/lib/userError";
import { useDescribeError } from "@/i18n/describeError";
import { track } from "@/lib/analytics";

// The card's way forward when the project it was opened on can't be shown.
// The card is the whole surface, so there is no projects home to go back to:
// a new cloud project is made and opened here in its place.
export function EmbeddedNewProject() {
  const t = useTranslations("home.embeddedNewProject");
  const describeError = useDescribeError();
  const router = useRouter();
  const base = useCutBase();
  const client = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const create = async () => {
    setBusy(true);
    setError(null);
    try {
      // The card carries no upgrade wall, so the limit is said here.
      if (!(await newProjectAllowed(client))) {
        throw new Error(t("limit"));
      }
      const aspect = lastChosenAspect() ?? undefined;
      const res = await cloudBackend.fetch("/api/cut/projects", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: creatorNames().untitled, folderId: null, aspect }),
      });
      if (!res.ok) throw errorFromBody(await res.json().catch(() => null), t("failed"));
      const project = (await res.json()) as ProjectSummary;
      seedNewProjectDoc(project.id, project.name, "cloud", aspect);
      track("project_created", { source: "chatgpt_card" });
      router.replace(framedHref(projectHref(base, project.id, "projects")));
    } catch (e) {
      setError(describeError(e, t("failed")));
      setBusy(false);
    }
  };

  return (
    <>
      <Button variant="outline" disabled={busy} onClick={() => void create()}>
        {t("create")}
      </Button>
      {error && <p className="text-xs text-destructive">{error}</p>}
    </>
  );
}
