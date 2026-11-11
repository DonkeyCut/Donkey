"use client";

import { Suspense, useEffect, useState } from "react";
import { useParams } from "next/navigation";
import { Loader2 } from "lucide-react";
import { useTranslations } from "next-intl";
import { TemplateInfo, TemplateTopBar } from "@/cut/components/TemplateInfo";
import { TemplatePlayer } from "@/cut/components/TemplatePlayer";
import { bindCutMode } from "@/cut/lib/backend";
import { bindTemplateBackend, templateBackendFor } from "@/cut/lib/backend/shared";
import { holdThreadsInMemory } from "@/cut/lib/chatThreads";
import { useTemplateIndex } from "@/cut/lib/queries";
import { useEditor } from "@/cut/lib/store";
import type { GalleryTemplate } from "@/cut/lib/templateGallery";
import type { ShareFeatures } from "@/cut/lib/types";

type Gate = { state: "loading" } | { state: "ready"; projectId: string } | { state: "missing" };

// A published template reads like a public share: its meta fetch finds the
// project, the page binds the template's read-only backend, and the player
// plays it live beside the panel that says what it is. A phone stacks the
// two.
function TemplateDetail({ template }: { template: GalleryTemplate }) {
  const [gate, setGate] = useState<Gate>({ state: "loading" });

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
        bindTemplateBackend(template.id);
        bindCutMode("shared");
        holdThreadsInMemory();
        useEditor.getState().setSharedView(meta.features);
        setGate({ state: "ready", projectId: meta.projectId });
      })
      .catch(() => alive && setGate({ state: "missing" }));
    return () => {
      alive = false;
    };
  }, [template.id]);

  if (gate.state === "missing") {
    return <Missing />;
  }
  // On a phone the player takes the template's own shape, capped so the
  // panel under it stays in reach.
  const [w, h] = template.aspect.split(":").map(Number);
  return (
    <div className="flex h-[100dvh] flex-col overflow-y-auto md:flex-row md:overflow-hidden">
      <div className="flex min-w-0 shrink-0 flex-col md:min-h-0 md:flex-1">
        <div className="h-[46px] shrink-0">
          <TemplateTopBar template={template} />
        </div>
        <div
          className="aspect-(--frame) max-h-[70dvh] min-h-0 md:aspect-auto md:max-h-none md:flex-1"
          style={{ "--frame": `${w} / ${h}` } as React.CSSProperties}
        >
          {gate.state === "ready" ? (
            <TemplatePlayer projectId={gate.projectId} />
          ) : (
            <div className="grid h-full place-items-center text-muted-foreground">
              <Loader2 className="size-5 animate-spin" />
            </div>
          )}
        </div>
      </div>
      <aside className="shrink-0 border-t border-border bg-card md:w-80 md:overflow-y-auto md:border-t-0 md:border-l">
        <TemplateInfo template={template} />
      </aside>
    </div>
  );
}

function Missing() {
  const t = useTranslations("home.templates");
  return (
    <div className="grid h-[100dvh] place-items-center px-4">
      <p className="text-sm text-muted-foreground">{t("detail.missing")}</p>
    </div>
  );
}

function TemplateFromRoute() {
  const { id } = useParams<{ id: string }>();
  const index = useTemplateIndex();
  const template = index.data?.templates.find((t) => t.id === decodeURIComponent(id));
  if (index.isPending) {
    return (
      <div className="grid h-[100dvh] place-items-center text-muted-foreground">
        <Loader2 className="size-5 animate-spin" />
      </div>
    );
  }
  return template ? <TemplateDetail template={template} /> : <Missing />;
}

export function TemplateDetailView() {
  // `app-surface` repoints --background to the product surface the editor runs
  // on, as the share page does.
  return (
    <div className="app-surface h-[100dvh] bg-background font-system text-foreground antialiased">
      <Suspense>
        <TemplateFromRoute />
      </Suspense>
    </div>
  );
}
