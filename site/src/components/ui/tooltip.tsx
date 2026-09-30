"use client"

import { useState, useSyncExternalStore } from "react"
import { Tooltip as TooltipPrimitive } from "@base-ui/react/tooltip"

import { cn } from "@/lib/utils"

function TooltipProvider({
  delay = 0,
  ...props
}: TooltipPrimitive.Provider.Props) {
  return (
    <TooltipPrimitive.Provider
      data-slot="tooltip-provider"
      delay={delay}
      {...props}
    />
  )
}

// A drag carries the pointer off its trigger without the pointer leaving,
// so every drag start and end closes whatever tooltip is open.
let dragEpoch = 0
const dragListeners = new Set<() => void>()
const bumpDragEpoch = () => {
  dragEpoch++
  dragListeners.forEach((listener) => listener())
}
function subscribeDragEpoch(listener: () => void) {
  if (dragListeners.size === 0) {
    document.addEventListener("dragstart", bumpDragEpoch, true)
    document.addEventListener("dragend", bumpDragEpoch, true)
  }
  dragListeners.add(listener)
  return () => {
    dragListeners.delete(listener)
    if (dragListeners.size === 0) {
      document.removeEventListener("dragstart", bumpDragEpoch, true)
      document.removeEventListener("dragend", bumpDragEpoch, true)
    }
  }
}

const ignoreDragEpoch = () => () => {}

function Tooltip({
  open,
  defaultOpen = false,
  onOpenChange,
  ...props
}: TooltipPrimitive.Root.Props) {
  const [own, setOwn] = useState(defaultOpen)
  // Closed by a drag: stays closed until the tooltip next opens, or the
  // caller sets `open` again.
  const [dragged, setDragged] = useState(false)
  // The drag count this tooltip last caught up with.
  const [seen, setSeen] = useState(dragEpoch)
  const [lastOpen, setLastOpen] = useState(open)
  if (open !== lastOpen) {
    setLastOpen(open)
    setDragged(false)
    setSeen(dragEpoch)
  }
  const shown = (open ?? own) && !dragged
  // Only an open tooltip listens, so a drag re-renders nothing else.
  const epoch = useSyncExternalStore(
    shown ? subscribeDragEpoch : ignoreDragEpoch,
    () => dragEpoch,
    () => 0
  )
  if (epoch !== seen) {
    setSeen(epoch)
    if (shown) {
      setOwn(false)
      setDragged(true)
    }
  }
  return (
    <TooltipPrimitive.Root
      data-slot="tooltip"
      open={shown && epoch === seen}
      onOpenChange={(next, details) => {
        setOwn(next)
        setDragged(false)
        // Drags while it was closed are no reason to close it now.
        setSeen(dragEpoch)
        onOpenChange?.(next, details)
      }}
      {...props}
    />
  )
}

function TooltipTrigger({ ...props }: TooltipPrimitive.Trigger.Props) {
  return <TooltipPrimitive.Trigger data-slot="tooltip-trigger" {...props} />
}

function TooltipContent({
  className,
  side = "top",
  sideOffset = 6,
  align = "center",
  alignOffset = 0,
  children,
  ...props
}: TooltipPrimitive.Popup.Props &
  Pick<
    TooltipPrimitive.Positioner.Props,
    "align" | "alignOffset" | "side" | "sideOffset"
  >) {
  return (
    <TooltipPrimitive.Portal>
      <TooltipPrimitive.Positioner
        align={align}
        alignOffset={alignOffset}
        side={side}
        sideOffset={sideOffset}
        className="isolate z-50"
      >
        <TooltipPrimitive.Popup
          data-slot="tooltip-content"
          className={cn(
            "z-50 inline-flex w-fit max-w-xs origin-(--transform-origin) items-center gap-1.5 rounded-md bg-neutral-900 px-3 py-1.5 text-xs text-white shadow-md dark:ring-1 dark:ring-white/15 has-data-[slot=kbd]:pr-1.5 **:data-[slot=kbd]:relative **:data-[slot=kbd]:isolate **:data-[slot=kbd]:z-50 **:data-[slot=kbd]:rounded-sm data-[state=delayed-open]:animate-in data-[state=delayed-open]:fade-in-0 data-open:animate-in data-open:fade-in-0 data-open:duration-100 data-closed:animate-out data-closed:fade-out-0 data-closed:duration-75",
            className
          )}
          {...props}
        >
          {children}
        </TooltipPrimitive.Popup>
      </TooltipPrimitive.Positioner>
    </TooltipPrimitive.Portal>
  )
}

export { Tooltip, TooltipTrigger, TooltipContent, TooltipProvider }
