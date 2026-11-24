"use client";

import type { ReactNode } from "react";
import { Dialog as DialogPrimitive } from "@base-ui/react/dialog";
import { Dialog, DialogPortal } from "@/components/ui/dialog";

/** The sheet a template opens in, Donkey's or the person's own: a panel that
 * slides in from the right edge over the dimmed page behind it. */
export function TemplateSheet({
  open,
  title,
  onClose,
  children,
}: {
  open: boolean;
  title: string;
  onClose: () => void;
  children: ReactNode;
}) {
  return (
    <Dialog open={open} onOpenChange={(next) => !next && onClose()}>
      <DialogPortal>
        <DialogPrimitive.Backdrop className="fixed inset-0 z-50 bg-black/60 transition-opacity duration-300 ease-out supports-backdrop-filter:backdrop-blur-xs data-ending-style:opacity-0 data-starting-style:opacity-0" />
        <DialogPrimitive.Popup className="app-surface fixed inset-y-0 right-0 z-50 w-full max-w-[1600px] overflow-hidden border-border bg-background text-foreground shadow-2xl outline-none transition-transform duration-300 ease-out data-ending-style:translate-x-full data-starting-style:translate-x-full md:w-[calc(100vw-3rem)] md:rounded-l-2xl md:border-l">
          <DialogPrimitive.Title className="sr-only">{title}</DialogPrimitive.Title>
          {children}
        </DialogPrimitive.Popup>
      </DialogPortal>
    </Dialog>
  );
}
