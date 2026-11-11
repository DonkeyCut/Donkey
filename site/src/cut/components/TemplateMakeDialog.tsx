"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";
import { useDescribeError } from "@/i18n/describeError";
import { homeHref, useCutBase } from "@/cut/lib/nav";
import { newProjectAllowed } from "@/cut/lib/projectLimit";
import { refetchProjects } from "@/cut/lib/queries";
import type { Residency } from "@/cut/lib/residency";
import { copyAsKind } from "@/cut/lib/templateUse";
import type { ProjectSummary } from "@/cut/lib/types";
import { CardPreview } from "./ProjectsHome";
import { CopyDialog, type CopyPhase } from "./TemplateUseView";

// Projects without an aspect are 9:16.
const DEFAULT_ASPECT = "9:16";

/** "Make as Template" on a project: the copy runs in the same dialog a
 * template's use runs in, the other way round — the project's still and name,
 * a bar while its copy lands marked as a template, then the way to it under
 * Templates › My templates. */
export function TemplateMakeDialog({
  project: p,
  residency: r,
  onClose,
}: {
  project: ProjectSummary;
  residency: Residency;
  onClose: () => void;
}) {
  const t = useTranslations("home.projects");
  const tc = useTranslations("editor.bottomSheet");
  const describeError = useDescribeError();
  const base = useCutBase();
  const client = useQueryClient();
  const [phase, setPhase] = useState<CopyPhase>({ state: "copying", done: 0, total: 0 });
  const started = useRef(false);

  // The copy starts once, as the dialog opens. At the project limit the
  // upgrade prompt answers and the dialog offers the way back.
  useEffect(() => {
    if (started.current) {
      return;
    }
    started.current = true;
    void (async () => {
      try {
        if (!(await newProjectAllowed(client))) {
          setPhase({ state: "blocked" });
          return;
        }
        await copyAsKind(r, p.id, "template", p.name);
        void refetchProjects(client, r);
        setPhase({ state: "done" });
      } catch (e) {
        setPhase({ state: "failed", message: describeError(e, t("makeTemplateFailed")) });
      }
    })();
  }, [client, r, p.id, p.name, describeError, t]);

  return (
    <CopyDialog
      still={
        // The project's own frame shape, whole in the box.
        <div className="relative h-full max-w-full" style={{ aspectRatio: (p.aspect ?? DEFAULT_ASPECT).replace(":", " / ") }}>
          <CardPreview project={p} residency={r} />
        </div>
      }
      name={p.name}
      phase={phase}
      working={t("makingTemplate")}
      done={t("templateMade")}
      actions={
        <Button nativeButton={false} render={<Link href={`${homeHref(base, "templates")}?source=mine`} />}>
          {t("openTemplates")}
        </Button>
      }
      closeLabel={tc("close")}
      onClose={onClose}
    />
  );
}
