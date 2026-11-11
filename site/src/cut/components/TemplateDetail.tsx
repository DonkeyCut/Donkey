"use client";

import { useEffect, useState } from "react";
import { Loader2 } from "lucide-react";
import { useTranslations } from "next-intl";
import { templateBackendFor } from "@/cut/lib/backend/shared";
import type { GalleryTemplate } from "@/cut/lib/templateGallery";
import type { ShareFeatures } from "@/cut/lib/types";
import type { PanelNav } from "./GalleryTile";
import { TemplateInfo, TemplateTopBar } from "./TemplateInfo";
import { TemplatePlayer } from "./TemplatePlayer";

type Gate =
  | { state: "loading" }
  | { state: "ready"; templateId: string; projectId: string; features: ShareFeatures }
  | { state: "missing" };

/**
 * A published template, read like a public share: its meta fetch finds the
 * project, and the player binds the template's read-only backend and plays it
 * live beside the panel that says what it is. A phone stacks the two. The
 * template's own page and the gallery's panel both show it; `closeHref` is
 * where its close button goes, and `panel` keeps the close button and similar
 * templates inside the gallery's panel.
 */
export function TemplateDetail({
  template,
  closeHref,
  panel,
}: {
  template: GalleryTemplate;
  closeHref: string;
  panel?: PanelNav;
}) {
  const t = useTranslations("home.templates");
  const [gate, setGate] = useState<Gate>({ state: "loading" });

  // Another template's meta loads behind the one showing, which stays up
  // until the new one is ready to take its place.
  useEffect(() => {
    let alive = true;
    void templateBackendFor(template.id)
      .fetch("/api/cut")
      .then(async (res) => {
        if (!alive) {
          return;
        }
        if (!res.ok) {
          return setGate({ state: "missing" });
        }
        const meta = (await res.json()) as { projectId: string; features: ShareFeatures };
        setGate({ state: "ready", templateId: template.id, projectId: meta.projectId, features: meta.features });
      })
      .catch(() => alive && setGate({ state: "missing" }));
    return () => {
      alive = false;
    };
  }, [template.id]);

  // One that fails to load keeps its top bar, so the panel still closes.
  if (gate.state === "missing") {
    return (
      <div className="flex h-full flex-col">
        <div className="h-[46px] shrink-0">
          <TemplateTopBar template={template} closeHref={closeHref} panel={panel} />
        </div>
        <div className="grid flex-1 place-items-center px-4">
          <p className="text-sm text-muted-foreground">{t("detail.missing")}</p>
        </div>
      </div>
    );
  }
  return (
    <div className="flex h-full flex-col overflow-y-auto md:flex-row md:overflow-hidden">
      <div className="flex min-w-0 shrink-0 flex-col md:min-h-0 md:flex-1">
        <div className="h-[46px] shrink-0">
          <TemplateTopBar template={template} closeHref={closeHref} panel={panel} />
        </div>
        {/* On a phone the player and its timeline nearly fill the screen,
            and the panel scrolls up under them. */}
        <div className="h-[88dvh] min-h-0 md:h-auto md:flex-1">
          {gate.state === "ready" ? (
            <TemplatePlayer templateId={gate.templateId} projectId={gate.projectId} features={gate.features} />
          ) : (
            <div className="grid h-full place-items-center text-muted-foreground">
              <Loader2 className="size-5 animate-spin" />
            </div>
          )}
        </div>
      </div>
      <aside className="shrink-0 border-t border-border bg-card md:w-80 md:overflow-y-auto md:border-t-0 md:border-l">
        <TemplateInfo template={template} panel={panel} />
      </aside>
    </div>
  );
}
