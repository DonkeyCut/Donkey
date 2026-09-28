"use client";

import { useState, type ReactNode } from "react";
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

// Controls, folder tiles, and the crumb keep their own menus and clicks.
const OWN_MENU = "button,a,input,textarea,[role='button'],[role='menuitem'],[data-no-marquee]";

/**
 * The mechanics every tile grid shares — the projects home, the Library page,
 * and the editor's Media panel and Library shelf. A right-click over a tile
 * (marked `data-sel-id`, the mark `Marquee` sweeps) opens the selection menu
 * at the pointer, with the tile joining the pick if it wasn't in it, so the
 * browser's own media menu never shows over a tile. Each grid draws its own
 * entries inside `SelectionMenu`.
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
    if (t.closest(OWN_MENU)) return true;
    const card = t.closest<HTMLElement>("[data-sel-id]");
    if (!card) return false;
    const id = card.dataset.selId!;
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

/** The confirm before a pick is deleted. The grid words it: what goes, what
 * it takes with it, and what the button says. */
export function DeleteConfirm({
  open,
  title,
  description,
  action = "Delete",
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
  return (
    <AlertDialog open={open} onOpenChange={(o) => !o && onClose()}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          <AlertDialogDescription>{description}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={busy}>Cancel</AlertDialogCancel>
          <AlertDialogAction
            disabled={busy}
            className="bg-destructive/10 text-destructive hover:bg-destructive/20"
            onClick={(e) => {
              e.preventDefault();
              onConfirm();
            }}
          >
            {action}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
