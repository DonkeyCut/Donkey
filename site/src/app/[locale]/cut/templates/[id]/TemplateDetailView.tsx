"use client";

import { Suspense, useEffect, useState } from "react";
import { useParams } from "next/navigation";
import { Loader2 } from "lucide-react";
import { useTranslations } from "next-intl";
import { Editor } from "@/cut/components/Editor";
import { TemplateInfo, TemplateTopBar } from "@/cut/components/TemplateInfo";
import { useIsNarrowAtOpen } from "@/cut/hooks/useIsNarrow";
import { bindCutMode } from "@/cut/lib/backend";
import { bindTemplateBackend, templateBackendFor } from "@/cut/lib/backend/shared";
import { holdThreadsInMemory } from "@/cut/lib/chatThreads";
import { useTemplateIndex } from "@/cut/lib/queries";
import { useEditor } from "@/cut/lib/store";
import { templateMotion, type GalleryTemplate } from "@/cut/lib/templateGallery";
import type { ShareFeatures } from "@/cut/lib/types";

type Gate = { state: "loading" } | { state: "ready"; projectId: string } | { state: "missing" };

// A published template reads like a public share: its meta fetch finds the
// project, the page binds the template's read-only backend, and the editor
// mounts read-only.
function TemplateDetail({ template }: { template: GalleryTemplate }) {
  const [gate, setGate] = useState<Gate>({ state: "loading" });
  const narrow = useIsNarrowAtOpen();

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

  // A phone gets the moving card and the panel; the editor starts a decoder
  // per clip the moment it mounts, which a narrow screen cannot pay for.
  if (narrow) {
    const [w, h] = template.aspect.split(":").map(Number);
    return (
      <div className="flex min-h-[100dvh] flex-col">
        <div className="h-[46px] shrink-0 border-b border-border">
          <TemplateTopBar template={template} />
        </div>
        <div className="mx-4 mt-4 overflow-hidden rounded-2xl border border-border bg-muted" style={{ aspectRatio: `${w} / ${h}` }}>
          <video src={templateMotion(template)} autoPlay muted loop playsInline className="size-full object-cover" />
        </div>
        <TemplateInfo template={template} />
      </div>
    );
  }

  if (gate.state === "missing") {
    return <Missing />;
  }
  if (gate.state === "ready" && narrow === false) {
    return <Editor projectId={gate.projectId} viewer template={template} />;
  }
  return (
    <div className="grid h-[100dvh] place-items-center text-muted-foreground">
      <Loader2 className="size-5 animate-spin" />
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
