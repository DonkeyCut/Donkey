"use client"

import * as React from "react"
import { Popover as PopoverPrimitive } from "@base-ui/react/popover"

import { cn } from "@/lib/utils"

// The popover closes on the press that lands outside it, not on the click
// that follows. The editor's gestures — a pan on the preview, a drag on the
// timeline — swallow their own click, and a popover waiting for one stays
// open through a press that plainly meant to leave it.
type Outside = {
  actions: React.RefObject<PopoverPrimitive.Root.Actions | null>
  triggers: React.RefObject<Set<Element>>
}

const OutsideContext = React.createContext<Outside | null>(null)

// Every popup this kit portals out of the tree; a press inside one of them
// belongs to that popup, whichever popover is open behind it.
const POPUP_SELECTOR =
  '[data-slot$="-content"], [role="dialog"], [role="menu"], [role="listbox"]'

function Popover({ actionsRef, ...props }: PopoverPrimitive.Root.Props) {
  const ownActions = React.useRef<PopoverPrimitive.Root.Actions | null>(null)
  const triggers = React.useRef<Set<Element>>(new Set())
  const actions = actionsRef ?? ownActions
  const outside = React.useMemo(() => ({ actions, triggers }), [actions])
  return (
    <OutsideContext.Provider value={outside}>
      <PopoverPrimitive.Root data-slot="popover" actionsRef={actions} {...props} />
    </OutsideContext.Provider>
  )
}

function PopoverTrigger({ ref, ...props }: PopoverPrimitive.Trigger.Props) {
  const outside = React.useContext(OutsideContext)
  const track = React.useCallback(
    (el: HTMLElement | null) => {
      if (el) outside?.triggers.current.add(el)
      return () => {
        if (el) outside?.triggers.current.delete(el)
      }
    },
    [outside]
  )
  return (
    <PopoverPrimitive.Trigger
      data-slot="popover-trigger"
      ref={mergeRefs(ref, track)}
      {...props}
    />
  )
}

function PopoverContent({
  align = "center",
  alignOffset = 0,
  side = "bottom",
  sideOffset = 4,
  className,
  ref,
  ...props
}: PopoverPrimitive.Popup.Props &
  Pick<
    PopoverPrimitive.Positioner.Props,
    "align" | "alignOffset" | "side" | "sideOffset"
  >) {
  const outside = React.useContext(OutsideContext)
  const popup = React.useRef<HTMLDivElement | null>(null)

  // The popup is mounted only while open, so this listens exactly as long as
  // there is something to dismiss. Capture phase, on the document: the
  // editor's gestures stop the press on its way up, so a bubbling listener
  // would miss it.
  React.useEffect(() => {
    if (!outside) return
    const onDown = (e: PointerEvent) => {
      const target = e.target
      if (!(target instanceof Element)) return
      const box = popup.current
      if (box && box.contains(target)) return
      for (const trigger of outside.triggers.current) {
        if (trigger.contains(target)) return
      }
      if (target.closest(POPUP_SELECTOR)) return
      outside.actions.current?.close()
    }
    document.addEventListener("pointerdown", onDown, true)
    return () => document.removeEventListener("pointerdown", onDown, true)
  }, [outside])

  return (
    <PopoverPrimitive.Portal>
      <PopoverPrimitive.Positioner
        className="isolate z-50 outline-none"
        align={align}
        alignOffset={alignOffset}
        side={side}
        sideOffset={sideOffset}
      >
        <PopoverPrimitive.Popup
          data-slot="popover-content"
          ref={mergeRefs(ref, popup)}
          className={cn(
            "z-50 max-h-(--available-height) origin-(--transform-origin) rounded-lg bg-popover text-popover-foreground shadow-md ring-1 ring-foreground/10 duration-100 outline-none data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2 data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95",
            className,
          )}
          {...props}
        />
      </PopoverPrimitive.Positioner>
    </PopoverPrimitive.Portal>
  )
}

function mergeRefs<T>(
  ...refs: (React.Ref<T> | undefined)[]
): React.RefCallback<T> {
  return (value) => {
    const cleanups = refs.map((ref) => {
      if (!ref) return undefined
      if (typeof ref === "function") return ref(value)
      ref.current = value
      return undefined
    })
    return () => {
      cleanups.forEach((cleanup, i) => {
        if (typeof cleanup === "function") cleanup()
        else {
          const ref = refs[i]
          if (ref && typeof ref !== "function") ref.current = null
        }
      })
    }
  }
}

export { Popover, PopoverTrigger, PopoverContent }
