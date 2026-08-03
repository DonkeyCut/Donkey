"use client"

import * as React from "react"
import { ScrollArea as ScrollAreaPrimitive } from "@base-ui/react/scroll-area"

import { cn } from "@/lib/utils"

/**
 * A vertical scroll container with a thin scrollbar that floats over the
 * content: it fades in while the pointer is inside or the view is scrolling,
 * and it takes no width from the layout, so a narrow column keeps every pixel
 * it has. `contentClassName` styles the scrolling content itself — padding and
 * layout belong there, sizing on the outer element.
 */
function ScrollArea({
  className,
  contentClassName,
  children,
  ...props
}: ScrollAreaPrimitive.Root.Props & { contentClassName?: string }) {
  return (
    <ScrollAreaPrimitive.Root
      data-slot="scroll-area"
      className={cn("relative", className)}
      {...props}
    >
      <ScrollAreaPrimitive.Viewport
        data-slot="scroll-area-viewport"
        className="size-full rounded-[inherit] outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
      >
        <ScrollAreaPrimitive.Content
          data-slot="scroll-area-content"
          className={contentClassName}
          // The part ships `min-width: fit-content` for horizontal scrolling;
          // this one scrolls down only, and fit-content lets one long unbroken
          // line widen the column past its own bounds.
          style={{ minWidth: "auto" }}
        >
          {children}
        </ScrollAreaPrimitive.Content>
      </ScrollAreaPrimitive.Viewport>
      <ScrollBar />
      <ScrollAreaPrimitive.Corner data-slot="scroll-area-corner" />
    </ScrollAreaPrimitive.Root>
  )
}

function ScrollBar({
  className,
  orientation = "vertical",
  ...props
}: ScrollAreaPrimitive.Scrollbar.Props) {
  return (
    <ScrollAreaPrimitive.Scrollbar
      data-slot="scroll-area-scrollbar"
      orientation={orientation}
      className={cn(
        // The track stays a comfortable grab target; the padding is what makes
        // the thumb inside it read as a hairline.
        "z-10 flex touch-none p-[3px] opacity-0 transition-opacity select-none data-hovering:opacity-100 data-scrolling:opacity-100 data-scrolling:duration-0",
        orientation === "vertical" && "h-full w-2.5",
        orientation === "horizontal" && "h-2.5 flex-col",
        className
      )}
      {...props}
    >
      <ScrollAreaPrimitive.Thumb
        data-slot="scroll-area-thumb"
        className="relative flex-1 rounded-full bg-foreground/25"
      />
    </ScrollAreaPrimitive.Scrollbar>
  )
}

export { ScrollArea, ScrollBar }
