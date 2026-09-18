"use client"

import * as React from "react"
import { Dialog as DialogPrimitive } from "@base-ui/react/dialog"

import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import { XIcon } from "lucide-react"

function Dialog({ ...props }: DialogPrimitive.Root.Props) {
  return <DialogPrimitive.Root data-slot="dialog" {...props} />
}

function DialogTrigger({ ...props }: DialogPrimitive.Trigger.Props) {
  return <DialogPrimitive.Trigger data-slot="dialog-trigger" {...props} />
}

function DialogPortal({ ...props }: DialogPrimitive.Portal.Props) {
  return <DialogPrimitive.Portal data-slot="dialog-portal" {...props} />
}

function DialogClose({ ...props }: DialogPrimitive.Close.Props) {
  return <DialogPrimitive.Close data-slot="dialog-close" {...props} />
}

function DialogOverlay({
  className,
  ...props
}: DialogPrimitive.Backdrop.Props) {
  return (
    <DialogPrimitive.Backdrop
      data-slot="dialog-overlay"
      className={cn(
        "fixed inset-0 isolate z-50 bg-black/10 duration-100 supports-backdrop-filter:backdrop-blur-xs data-open:animate-in data-open:fade-in-0 data-closed:animate-out data-closed:fade-out-0",
        className
      )}
      {...props}
    />
  )
}

// Where every modal hangs: a full-viewport column holding the popup, with a
// collapsible spacer above it. The spacer holds the dialog in the top third
// while the viewport has room and gives its height back when it runs short, so
// the whole dialog stays on screen in a frame as short as the ChatGPT card or a
// phone in landscape. A dialog never sets its own top.
function ModalPositioner({
  className,
  children,
  ...props
}: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="modal-positioner"
      className={cn(
        "pointer-events-none fixed inset-0 z-50 flex flex-col items-center p-4",
        className
      )}
      {...props}
    >
      <div aria-hidden className="w-0 shrink-[999] basis-[18dvh]" />
      {children}
    </div>
  )
}

// The popup fills at most the space the positioner leaves it, and its scrolling
// part takes up the slack. A dialog that declares no scrolling part at all
// scrolls whole.
const modalPopupClasses =
  "pointer-events-auto relative max-h-full min-h-0 w-full overflow-y-auto overscroll-contain rounded-xl bg-popover text-popover-foreground ring-1 ring-foreground/10 duration-100 outline-none has-data-[slot=dialog-body]:overflow-y-visible data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95"

// A dialog that never named its scrolling part still gets one: the header and
// footer it declared stay where they are, and everything between them scrolls
// in the space that is left. The wrapper inherits the popup's column and gap,
// so the dialog lays out exactly as it did with the room it has.
function withScrollingMiddle(
  children: React.ReactNode,
  chromeTypes: React.ElementType[]
) {
  const nodes = React.Children.toArray(children)
  const isType = (node: React.ReactNode, type: React.ElementType) =>
    React.isValidElement(node) && node.type === type
  if (nodes.some((node) => isType(node, DialogBody))) return children
  const chrome = (node: React.ReactNode) =>
    chromeTypes.some((type) => isType(node, type))
  let start = 0
  while (start < nodes.length && chrome(nodes[start])) start += 1
  let end = nodes.length
  while (end > start && chrome(nodes[end - 1])) end -= 1
  const middle = nodes.slice(start, end)
  if (middle.length === 0 || middle.length === nodes.length) return children
  return [
    ...nodes.slice(0, start),
    <DialogBody
      key="dialog-body"
      className="mx-0 my-0 flex flex-col gap-[inherit] px-0 py-0"
    >
      {middle}
    </DialogBody>,
    ...nodes.slice(end),
  ]
}

function DialogContent({
  className,
  children,
  overlayClassName,
  showCloseButton = true,
  ...props
}: DialogPrimitive.Popup.Props & {
  overlayClassName?: string
  showCloseButton?: boolean
}) {
  return (
    <DialogPortal>
      <DialogOverlay className={overlayClassName} />
      <ModalPositioner>
        <DialogPrimitive.Popup
          data-slot="dialog-content"
          className={cn(
            modalPopupClasses,
            "flex flex-col gap-4 p-4 text-sm sm:max-w-sm",
            className
          )}
          {...props}
        >
          {withScrollingMiddle(children, [DialogHeader, DialogFooter])}
          {showCloseButton && (
            <DialogPrimitive.Close
              data-slot="dialog-close"
              render={
                <Button
                  variant="ghost"
                  className="absolute top-2 right-2"
                  size="icon-sm"
                />
              }
            >
              <XIcon />
              <span className="sr-only">Close</span>
            </DialogPrimitive.Close>
          )}
        </DialogPrimitive.Popup>
      </ModalPositioner>
    </DialogPortal>
  )
}

function DialogHeader({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="dialog-header"
      className={cn("flex flex-col gap-2", className)}
      {...props}
    />
  )
}

// The part of a dialog that scrolls. The header, its close button and the
// footer stay in place whatever the body's height.
function DialogBody({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="dialog-body"
      className={cn("-mx-4 -my-1 min-h-0 flex-1 overflow-y-auto px-4 py-1", className)}
      {...props}
    />
  )
}

function DialogFooter({
  className,
  showCloseButton = false,
  children,
  ...props
}: React.ComponentProps<"div"> & {
  showCloseButton?: boolean
}) {
  return (
    <div
      data-slot="dialog-footer"
      className={cn(
        "-mx-4 -mb-4 flex flex-col-reverse gap-2 rounded-b-xl border-t bg-muted/50 p-4 sm:flex-row sm:justify-end",
        className
      )}
      {...props}
    >
      {children}
      {showCloseButton && (
        <DialogPrimitive.Close render={<Button variant="outline" />}>
          Close
        </DialogPrimitive.Close>
      )}
    </div>
  )
}

function DialogTitle({ className, ...props }: DialogPrimitive.Title.Props) {
  return (
    <DialogPrimitive.Title
      data-slot="dialog-title"
      className={cn(
        "font-heading text-base leading-none font-medium",
        className
      )}
      {...props}
    />
  )
}

function DialogDescription({
  className,
  ...props
}: DialogPrimitive.Description.Props) {
  return (
    <DialogPrimitive.Description
      data-slot="dialog-description"
      className={cn(
        "text-sm text-muted-foreground *:[a]:underline *:[a]:underline-offset-3 *:[a]:hover:text-foreground",
        className
      )}
      {...props}
    />
  )
}

export {
  Dialog,
  ModalPositioner,
  modalPopupClasses,
  withScrollingMiddle,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogBody,
  DialogOverlay,
  DialogPortal,
  DialogTitle,
  DialogTrigger,
}
