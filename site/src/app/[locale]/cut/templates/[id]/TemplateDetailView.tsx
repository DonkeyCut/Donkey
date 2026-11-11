"use client";

import { Suspense } from "react";
import { useParams } from "next/navigation";
import { Loader2 } from "lucide-react";
import { useTranslations } from "next-intl";
import { TemplateDetail } from "@/cut/components/TemplateDetail";
import { homeHref, useCutBase } from "@/cut/lib/nav";
import { useTemplateIndex } from "@/cut/lib/queries";

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
  const base = useCutBase();
  const template = index.data?.templates.find((t) => t.id === decodeURIComponent(id));
  if (index.isPending) {
    return (
      <div className="grid h-[100dvh] place-items-center text-muted-foreground">
        <Loader2 className="size-5 animate-spin" />
      </div>
    );
  }
  // Its own page closes to the gallery and opens a similar template as a page.
  return template ? (
    <div className="h-[100dvh]">
      <TemplateDetail template={template} closeHref={homeHref(base, "templates")} />
    </div>
  ) : (
    <Missing />
  );
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
