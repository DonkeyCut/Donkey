"use client";

import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { Clapperboard, FolderOpen, Loader2, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { apiFetch, getBackend } from "@/cut/lib/backend";
import { seedNewProjectDoc } from "@/cut/lib/docCache";
import { patchProjects } from "@/cut/lib/queries";
import { track } from "@/lib/analytics";
import { NavUser } from "@/cut/components/NavUser";
import { homeHref, projectHref, tabForPath, useCutBase, type CutTab } from "@/cut/lib/nav";
import type { ProjectSummary } from "@/cut/lib/types";
import { cn } from "@/lib/utils";

const NAV: { tab: CutTab; label: string; icon: typeof Clapperboard }[] = [
  { tab: "projects", label: "Projects", icon: Clapperboard },
  { tab: "library", label: "Library", icon: FolderOpen },
];

export function AppSidebar() {
  const pathname = usePathname();
  const router = useRouter();
  const base = useCutBase();
  const client = useQueryClient();
  const [createOpen, setCreateOpen] = useState(false);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);

  const create = async () => {
    setBusy(true);
    try {
      const res = await apiFetch("/api/cut/projects", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: name.trim() || "Untitled" }),
      });
      const project = (await res.json()) as ProjectSummary;
      const kind = getBackend().kind;
      patchProjects(client, kind === "cloud" ? "cloud" : "local", (s) => ({
        ...s,
        projects: [project, ...s.projects],
      }));
      // A brand-new project's document is empty, so the editor about to open
      // needs no round trip to draw it.
      seedNewProjectDoc(project.id, project.name, kind);
      track("project_created", { source: "sidebar" });
      // The sidebar creates on the globally bound backend, so the link carries
      // that residency.
      router.push(projectHref(base, project.id, tabForPath(pathname), null));
    } finally {
      setBusy(false);
    }
  };

  return (
    <aside className="flex w-60 shrink-0 flex-col border-r border-border bg-card px-3 py-4">
      <div className="mb-5 flex items-center gap-2.5 px-2">
        <span className="grid size-9 shrink-0 place-items-center p-0.5">
          <img
            src="/donkey-logo.svg"
            alt="Donkey Cut"
            width={36}
            height={36}
            className="block h-full w-full object-contain"
          />
        </span>
        <span className="text-[17px] font-semibold tracking-tight">Donkey Cut</span>
      </div>

      <Button
        className="mb-5 w-full"
        onClick={() => {
          setName("");
          setCreateOpen(true);
        }}
      >
        <Plus data-icon="inline-start" /> New project
      </Button>

      <nav className="flex flex-col gap-0.5">
        {NAV.map(({ tab, label, icon: Icon }) => {
          const href = homeHref(base, tab);
          const active = pathname === href;
          return (
            <Link
              key={tab}
              href={href}
              className={cn(
                "flex items-center gap-2.5 rounded-lg px-2.5 py-2 text-sm font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground",
                active && "bg-muted text-foreground"
              )}
            >
              <Icon className="size-4" />
              {label}
            </Link>
          );
        })}
      </nav>
      <NavUser />
      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>New project</DialogTitle>
          </DialogHeader>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void create();
            }}
          >
            <Input
              autoFocus
              placeholder="Project name"
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
            <DialogFooter className="mt-4">
              <Button type="submit" disabled={busy} className="w-full">
                {busy && <Loader2 className="animate-spin" data-icon="inline-start" />}
                Create project
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </aside>
  );
}
