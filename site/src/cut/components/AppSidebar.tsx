"use client";

import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { Camera, Clapperboard, FolderOpen, Loader2, StickyNote } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { seedNewProjectDoc } from "@/cut/lib/docCache";
import { patchProjects, usePhoneLink } from "@/cut/lib/queries";
import { backendFor, type Residency } from "@/cut/lib/residency";
import { track } from "@/lib/analytics";
import { NavStorage } from "@/cut/components/NavStorage";
import { NewProjectButton } from "@/cut/components/NewProjectButton";
import { NavUser } from "@/cut/components/NavUser";
import { homeHref, projectHref, tabForPath, useCutBase, type CutTab } from "@/cut/lib/nav";
import type { ProjectSummary } from "@/cut/lib/types";
import { cn } from "@/lib/utils";

const NAV: { tab: CutTab; label: string; icon: typeof Clapperboard }[] = [
  { tab: "projects", label: "Projects", icon: Clapperboard },
  { tab: "library", label: "Library", icon: FolderOpen },
];

// Surfaces fed by the iOS app, listed only for accounts that use it.
const PHONE_NAV: { tab: CutTab; label: string; icon: typeof Clapperboard }[] = [
  { tab: "camera-roll", label: "Camera Roll", icon: Camera },
  { tab: "notes", label: "Notes", icon: StickyNote },
];

export function AppSidebar() {
  const pathname = usePathname();
  const router = useRouter();
  const base = useCutBase();
  const client = useQueryClient();
  const phoneLinked = usePhoneLink();
  // The residency the pending creation was launched for; null when the naming
  // dialog is closed.
  const [createIn, setCreateIn] = useState<Residency | null>(null);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);

  const create = async (r: Residency) => {
    setBusy(true);
    try {
      const res = await backendFor(r).fetch("/api/cut/projects", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: name.trim() || "Untitled" }),
      });
      const project = (await res.json()) as ProjectSummary;
      patchProjects(client, r, (s) => ({
        ...s,
        projects: [project, ...s.projects],
      }));
      // A brand-new project's document is empty, so the editor about to open
      // needs no round trip to draw it.
      seedNewProjectDoc(project.id, project.name, r);
      track("project_created", { source: "sidebar" });
      // The dialog closes here, before the editor opens: the page it sits on
      // stays mounted behind the editor, and a dialog left open on it would
      // still be open on the way back.
      setCreateIn(null);
      // The link carries no residency; the editor resolves it by asking which
      // backend owns the id, so a cloud project created from a Mac still opens
      // against the cloud.
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

      {/* The one place the shelf is chosen: everything else follows it. */}
      <NewProjectButton
        picker
        className="mb-5 w-full"
        onCreate={(r) => {
          setName("");
          setCreateIn(r);
        }}
      />

      <nav className="flex flex-col gap-0.5">
        {[...NAV, ...(phoneLinked ? PHONE_NAV : [])].map(({ tab, label, icon: Icon }) => {
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
      <div className="mt-auto flex flex-col">
        <NavStorage />
        <NavUser />
      </div>
      <Dialog open={createIn !== null} onOpenChange={(o) => !o && setCreateIn(null)}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>New project</DialogTitle>
          </DialogHeader>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              if (createIn) void create(createIn);
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
