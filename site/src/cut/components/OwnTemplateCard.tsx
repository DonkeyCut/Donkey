"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { LayoutTemplate, Loader2, MoreHorizontal, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useDescribeError } from "@/i18n/describeError";
import { apiJson } from "@/cut/lib/api";
import {
  clearRefDrag,
  setRefDragData,
  type AssetRef,
} from "@/cut/lib/assetRef";
import { projectHref, useCutBase, type CutTab } from "@/cut/lib/nav";
import { newProjectAllowed } from "@/cut/lib/projectLimit";
import { forgetProject } from "@/cut/lib/projectPurge";
import { refetchProjects } from "@/cut/lib/queries";
import { backendFor, type Residency } from "@/cut/lib/residency";
import { copyAsKind } from "@/cut/lib/templateUse";
import { formatTime } from "@/cut/lib/time";
import type { ProjectSummary } from "@/cut/lib/types";
import { errorFromBody } from "@/cut/lib/userError";
import { track } from "@/lib/analytics";
import { CardPreview } from "./assets/ProjectCard";
import { TemplateCaption, TemplateFacts } from "./GalleryTile";
import { DeleteConfirm } from "./selectionMenu";

// Projects without an aspect are 9:16.
export const DEFAULT_ASPECT = "9:16";

export type OwnTemplate = { project: ProjectSummary; residency: Residency };

/** One of the person's own templates: a project of theirs marked as one. It
 * opens in the editor like any project; its menu makes a new project from it
 * or deletes it. */
export function OwnTemplateCard({
  template,
  from,
  dragRef,
}: {
  template: OwnTemplate;
  /** The Home tab the editor's back button returns to. */
  from: CutTab;
  /** What the card carries when dragged, e.g. into Home's prompt box. */
  dragRef?: AssetRef;
}) {
  const t = useTranslations("home.templates");
  const tp = useTranslations("home.projects");
  const tk = useTranslations("home.pick");
  const describeError = useDescribeError();
  const router = useRouter();
  const base = useCutBase();
  const client = useQueryClient();
  const { project: p, residency: r } = template;
  const [busy, setBusy] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // A copy of the template on its own shelf, marked a project, opened.
  const startFrom = async () => {
    setError(null);
    if (!(await newProjectAllowed(client))) {
      return;
    }
    setBusy(true);
    try {
      const id = await copyAsKind(r, p.id, "project", p.name);
      void refetchProjects(client, r);
      track("project_created", { source: "template" });
      router.push(projectHref(base, id, "home"));
    } catch (e) {
      setError(describeError(e, t("detail.failed")));
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    setBusy(true);
    try {
      const res = await backendFor(r).fetch(`/api/cut/projects/${p.id}`, {
        method: "DELETE",
      });
      if (!res.ok) {
        throw errorFromBody(
          await apiJson<object>(res),
          tp("deleteProjectFailed"),
        );
      }
      forgetProject(p.id, r);
      void refetchProjects(client, r);
      setDeleting(false);
    } catch (e) {
      setError(describeError(e, tp("deleteProjectFailed")));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="group relative min-w-0">
      <Link
        href={projectHref(base, p.id, from)}
        onDragStart={dragRef ? (e) => setRefDragData(e, dragRef) : undefined}
        onDragEnd={dragRef ? clearRefDrag : undefined}
        className="flex min-w-0 flex-col gap-3 outline-none"
      >
        <div className="relative grid aspect-video place-items-center overflow-hidden rounded-2xl border border-border bg-black transition-shadow group-hover:shadow-[0_6px_28px_rgba(0,0,0,0.12)] group-has-focus-visible:ring-3 group-has-focus-visible:ring-ring/50">
          {/* The project's own frame shape, whole in the tile, as gallery
              tiles stand their stills. */}
          <div
            className="relative h-full max-w-full"
            style={{
              aspectRatio: (p.aspect ?? DEFAULT_ASPECT).replace(":", " / "),
            }}
          >
            <CardPreview project={p} residency={r} />
          </div>
          {busy && (
            <span className="absolute inset-0 grid place-items-center bg-black/40">
              <Loader2 className="size-5 animate-spin text-white" />
            </span>
          )}
          <TemplateFacts facts={[t("sources.mine"), formatTime(p.duration)]} />
        </div>
        <TemplateCaption name={p.name} />
      </Link>
      {error && (
        <p className="mt-1 px-0.5 text-[13px] text-destructive">{error}</p>
      )}
      <DropdownMenu>
        <DropdownMenuTrigger
          render={
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={tp("actions")}
              disabled={busy}
              className="absolute top-2 right-2 bg-black/40 text-white opacity-0 group-hover:opacity-100 hover:bg-black/60 hover:text-white focus-visible:opacity-100 data-popup-open:opacity-100"
            />
          }
        >
          <MoreHorizontal />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem onClick={() => void startFrom()}>
            <LayoutTemplate /> {t("detail.use")}
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem
            variant="destructive"
            onClick={() => setDeleting(true)}
          >
            <Trash2 /> {tp("delete")}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <DeleteConfirm
        open={deleting}
        title={tp("deleteTitle", { what: tk("named", { name: p.name }) })}
        description={`${tp("deletesFolders", { count: 1 })} ${tp("cannotUndo")}`}
        action={tp("deleteProjects", { count: 1 })}
        busy={busy}
        onClose={() => setDeleting(false)}
        onConfirm={() => void remove()}
      />
    </div>
  );
}
