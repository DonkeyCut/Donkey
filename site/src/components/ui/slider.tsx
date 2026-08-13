import { Slider as SliderPrimitive } from "@base-ui/react/slider"

import { cn } from "@/lib/utils"
import { snapNear } from "@/lib/snap"

function Slider({
  className,
  defaultValue,
  value,
  min = 0,
  max = 100,
  snap,
  onValueChange,
  ...props
}: SliderPrimitive.Root.Props & {
  /**
   * Detent values: a pointer drag that comes within reach lands exactly on
   * one, which is how a nudged setting finds its way back to 100% or 0°.
   * Keyboard steps, rail clicks, and typed values stay exact, so every
   * deliberate placement can walk out of a detent.
   */
  snap?: number[]
}) {
  const handleValueChange: typeof onValueChange =
    snap && onValueChange
      ? (v, details) => {
          if (typeof v === "number" && details.reason === "drag") {
            v = snapNear(v, snap, min, max)
          }
          onValueChange(v, details)
        }
      : onValueChange
  // One thumb per actual value. A scalar renders exactly one thumb — a phantom
  // second thumb has no backing value, so Base UI ignores any rail click that
  // lands closest to it (the click resolves to a thumb index out of range).
  const _values = Array.isArray(value)
    ? value
    : value !== undefined
      ? [value]
      : Array.isArray(defaultValue)
        ? defaultValue
        : defaultValue !== undefined
          ? [defaultValue]
          : [min]

  return (
    <SliderPrimitive.Root
      className={cn("data-horizontal:w-full data-vertical:h-full", className)}
      data-slot="slider"
      defaultValue={defaultValue}
      value={value}
      min={min}
      max={max}
      onValueChange={handleValueChange}
      thumbAlignment="edge"
      {...props}
    >
      <SliderPrimitive.Control className="relative flex w-full cursor-pointer touch-none items-center select-none data-horizontal:py-2 data-disabled:opacity-50 data-vertical:h-full data-vertical:min-h-40 data-vertical:w-auto data-vertical:flex-col data-vertical:px-2">
        <SliderPrimitive.Track
          data-slot="slider-track"
          className="relative grow overflow-hidden rounded-full bg-muted select-none data-horizontal:h-1 data-horizontal:w-full data-vertical:h-full data-vertical:w-1"
        >
          <SliderPrimitive.Indicator
            data-slot="slider-range"
            className="bg-primary select-none data-horizontal:h-full data-vertical:w-full"
          />
        </SliderPrimitive.Track>
        {Array.from({ length: _values.length }, (_, index) => (
          <SliderPrimitive.Thumb
            data-slot="slider-thumb"
            key={index}
            className="relative block size-3 shrink-0 rounded-full border border-ring bg-white ring-ring/50 transition-[color,box-shadow] select-none after:absolute after:-inset-2 hover:ring-3 focus-visible:ring-3 focus-visible:outline-hidden active:ring-3 disabled:pointer-events-none disabled:opacity-50"
          />
        ))}
      </SliderPrimitive.Control>
    </SliderPrimitive.Root>
  )
}

export { Slider }
