"use client";

import { useState, type ReactNode } from "react";
import { useTranslations } from "next-intl";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { DropdownMenu, DropdownMenuContent } from "@/components/ui/dropdown-menu";

/** The right-click menu over a grid of tiles: where it opened, and the ids it
 * acts on, the clicked tile first. Empty ids is a menu over empty space. */
export type SelectionMenuAt = { x: number; y: number; ids: string[] };

// Controls and the crumb keep their own menus and clicks.
const OWN_MENU = "button,a,input,textarea,[role='button'],[role='menuitem'],[data-no-marquee]";

/**
 * The mechanics every tile grid shares — the projects home, the Library page,
 * Camera Roll, and the editor's Media panel and Library shelf. Every grid of
 * tiles picks and deletes the same way, a new tab included: `useTilePicks`
 * and `Marquee` pick, `useDeleteKey` and this menu act, `DeleteConfirm` asks
 * first. A right-click over a tile
 * (marked `data-sel-id`, the mark `Marquee` sweeps; a folder tile carries one
 * too) opens the selection menu at the pointer, with the tile joining the
 * pick if it wasn't in it, so the browser's own media menu never shows over a
 * tile. Each grid draws its own entries inside `SelectionMenu`.
 */
export function useSelectionMenu({
  picked,
  setPicked,
  shown,
}: {
  picked: Set<string>;
  setPicked: (s: Set<string>) => void;
  /** The ids on screen; a tile that isn't among them opens nothing. */
  shown: readonly string[];
}) {
  const [menu, setMenu] = useState<SelectionMenuAt | null>(null);
  const openAt = (e: { clientX: number; clientY: number }, ids: string[]) =>
    setMenu({ x: e.clientX, y: e.clientY, ids });
  // True when a tile or a control claimed the press, whether or not a menu
  // opened; a press over empty space is left to the grid.
  const onContextMenu = (e: React.MouseEvent): boolean => {
    const t = e.target as HTMLElement;
    // The nearest of the two decides: a tile inside the folder shelf is a
    // tile, a control inside a tile is a control.
    const card = t.closest<HTMLElement>(`[data-sel-id],${OWN_MENU}`);
    if (!card) return false;
    const id = card.dataset.selId;
    if (id === undefined) return true;
    if (!shown.includes(id)) return true;
    e.preventDefault();
    const ids = picked.has(id) ? [id, ...[...picked].filter((x) => x !== id)] : [id];
    if (!picked.has(id)) setPicked(new Set([id]));
    openAt(e, ids);
    return true;
  };
  return { menu, onContextMenu, openAt, close: () => setMenu(null) };
}

/** The menu `useSelectionMenu` opens, anchored to the pointer. Any entry
 * clicked closes it. */
export function SelectionMenu({
  menu,
  onClose,
  children,
}: {
  menu: SelectionMenuAt | null;
  onClose: () => void;
  children: ReactNode;
}) {
  return (
    <DropdownMenu open={menu !== null} onOpenChange={(o) => !o && onClose()}>
      {menu && (
        <DropdownMenuContent
          className="w-48"
          sideOffset={0}
          anchor={{
            getBoundingClientRect: () => new DOMRect(menu.x, menu.y, 0, 0),
          }}
          // No focus return on close — there is no trigger to go back to,
          // and reclaiming focus would blur a name field an entry opens,
          // whose blur cancels the creation.
          finalFocus={false}
          onClick={onClose}
        >
          {children}
        </DropdownMenuContent>
      )}
    </DropdownMenu>
  );
}

/** The grid's word for what it holds: the noun a confirm counts items in. */
export type PickNoun = "project" | "file" | "item" | "clip" | "note";

/**
 * The words a delete confirm is built from, in the page's language.
 *
 * `pickLabel` calls a pick the one thing by name, with what a folder holds
 * counted beside it; or the counts — "2 folders (19 projects) and 3
 * projects". `noun` is the grid's word for an item, the word for what the
 * folders hold too; `held` is how many of those the folders hold between
 * them, however deep.
 *
 * `foldersGoNote` is the sentence a confirm opens with while the pick holds
 * folders with something in them: a folder goes with everything inside it.
 * Empty when the folders hold nothing, or there are none.
 *
 * `phoneGoNote` is the sentence a Library confirm adds while what goes
 * includes items synced from the phone: those leave the phone too. `synced`
 * counts them among the `total` items going. Empty without one.
 *
 * Each sentence ends in a space, so the next one follows straight on.
 */
export function usePickWords() {
  const t = useTranslations("home.pick");

  const pickLabel = (
    folders: readonly { name: string }[],
    items: readonly { name: string }[],
    noun: PickNoun,
    held: number,
  ): string => {
    if (folders.length === 1 && items.length === 0) {
      const name = folders[0].name;
      return held > 0 ? t("namedHolding", { name, held: t(noun, { count: held }) }) : t("named", { name });
    }
    if (folders.length === 0 && items.length === 1) {
      return t("named", { name: items[0].name });
    }

    // Counts: the folders with what they hold, then the items beside them.
    const folderPart = folders.length
      ? held > 0
        ? t("foldersHolding", { folders: t("folder", { count: folders.length }), held: t(noun, { count: held }) })
        : t("folder", { count: folders.length })
      : "";
    const itemPart = items.length ? t(noun, { count: items.length }) : "";
    if (folderPart && itemPart) {
      return t("both", { folders: folderPart, items: itemPart });
    }
    return folderPart || itemPart;
  };

  const foldersGoNote = (folders: number, held: number): string => {
    if (folders === 0 || held === 0) {
      return "";
    }
    return `${t("foldersGo", { count: folders })} `;
  };

  const phoneGoNote = (synced: number, total: number): string => {
    if (synced === 0) {
      return "";
    }
    if (total === 1) {
      return `${t("phoneOnly")} `;
    }
    return `${t("phoneSome", { count: synced })} `;
  };

  return { pickLabel, foldersGoNote, phoneGoNote };
}

/** The confirm before a pick is deleted. The grid words it: what goes, what
 * it takes with it, and what the button says. */
export function DeleteConfirm({
  open,
  title,
  description,
  action,
  busy = false,
  onClose,
  onConfirm,
}: {
  open: boolean;
  title: ReactNode;
  description: ReactNode;
  action?: string;
  busy?: boolean;
  onClose: () => void;
  onConfirm: () => void;
}) {
  const t = useTranslations("home.pick");
  return (
    <AlertDialog open={open} onOpenChange={(o) => !o && onClose()}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          <AlertDialogDescription>{description}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={busy}>{t("cancel")}</AlertDialogCancel>
          <AlertDialogAction
            disabled={busy}
            className="bg-destructive/10 text-destructive hover:bg-destructive/20"
            onClick={(e) => {
              e.preventDefault();
              onConfirm();
            }}
          >
            {action ?? t("delete")}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
