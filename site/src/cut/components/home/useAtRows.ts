"use client";

import { useMemo } from "react";
import { useLocale } from "next-intl";
import { LIBRARY_MENTION, refFromLibrary, refFromTemplate } from "@/cut/lib/assetRef";
import { libraryFolderRefs } from "@/cut/lib/folderReference";
import { libraryAssetName, libraryMediaUrl } from "@/cut/lib/library";
import { noteRef } from "@/cut/lib/noteReference";
import { projectDocRef } from "@/cut/lib/projectLink";
import { useLibrary, useNotes, useOwnTemplates, useTemplateIndex } from "@/cut/lib/queries";
import { localized, templatePoster } from "@/cut/lib/templateGallery";
import { libraryTab, startTemplateRef, uniqueNames, type AtRow } from "./atRows";
import type { HomeProject } from "./useHomeProjects";

/**
 * Everything the `@` picker offers, as rows: the Library's files and folders,
 * notes, projects, and templates — the Library's saved arrangements, the
 * person's own, and Donkey's. Built only while the picker is open.
 */
export function useAtRows(open: boolean, projects: HomeProject[]): AtRow[] {
  const locale = useLocale();
  const library = useLibrary({ enabled: open }).data;
  const notes = useNotes(open).data;
  const own = useOwnTemplates();
  const gallery = useTemplateIndex().data;

  return useMemo(() => {
    if (!open) {
      return [];
    }
    const rows: AtRow[] = [];

    // Library files the chat can take: media as itself, a LUT by its tool.
    for (const a of library?.assets ?? []) {
      if (LIBRARY_MENTION[a.type].menu === "none") {
        continue;
      }
      const tab = libraryTab(a.type);
      rows.push({
        ref: refFromLibrary(a),
        label: libraryAssetName(a),
        tab,
        at: a.addedAt,
        preview: tab ? { kind: "library", asset: a } : { kind: "file", asset: a },
      });
    }

    // Folders, by their own name; the ref carries the path the chat reads.
    const folders = library?.folders ?? [];
    libraryFolderRefs(folders).forEach((ref, i) => {
      rows.push({ ref, label: folders[i].name, tab: "folders", at: folders[i].createdAt, preview: { kind: "icon", icon: "folder" } });
    });

    // Notes, newest edit first among the recents.
    for (const n of notes?.notes ?? []) {
      if (n.deletedAt) {
        continue;
      }
      rows.push({ ref: noteRef(n), label: n.title || noteRef(n).name, tab: "notes", at: n.updatedAt, preview: { kind: "note", colorIndex: n.colorIndex, body: n.body } });
    }

    // Projects, each one the chat can read.
    for (const { project, residency } of projects) {
      rows.push({
        ref: projectDocRef(project),
        label: project.name,
        tab: "projects",
        at: project.updatedAt,
        preview: { kind: "project", project, residency },
      });
    }

    // The person's own templates and Donkey's start the new project.
    for (const { project, residency } of own) {
      const start = { kind: "own" as const, project, residency };
      rows.push({
        ref: startTemplateRef(start, project.name),
        label: project.name,
        tab: "templates",
        at: project.updatedAt,
        preview: { kind: "project", project, residency },
        start,
      });
    }
    for (const template of gallery?.templates ?? []) {
      const name = localized(template.name, locale);
      const start = { kind: "gallery" as const, template };
      rows.push({ ref: startTemplateRef(start, name), label: name, tab: "templates", at: 0, preview: { kind: "template", poster: templatePoster(template) }, start });
    }

    // Snippets, the arrangements saved to the Library, are laid into the
    // project by the chat. A snippet's thumbnail is the first picture it lays in.
    for (const t of library?.templates ?? []) {
      const pic = t.media.find((m) => m.type === "image" || m.type === "video");
      const preview: AtRow["preview"] = pic
        ? { kind: "templateMedia", src: libraryMediaUrl(pic.fileName, t.residency), media: pic.type === "image" ? "image" : "video" }
        : { kind: "icon", icon: "file" };
      rows.push({ ref: refFromTemplate(t), label: t.name, tab: "snippets", at: t.addedAt, preview });
    }

    return uniqueNames(rows);
  }, [open, library, notes, projects, own, gallery, locale]);
}
