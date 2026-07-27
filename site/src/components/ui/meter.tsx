import { Meter as MeterPrimitive } from "@base-ui/react/meter"

import { cn } from "@/lib/utils"

function Meter({
  className,
  indicatorClassName,
  ...props
}: MeterPrimitive.Root.Props & { indicatorClassName?: string }) {
  return (
    <MeterPrimitive.Root data-slot="meter" className={cn("w-full", className)} {...props}>
      <MeterPrimitive.Track
        data-slot="meter-track"
        className="relative h-1.5 w-full overflow-hidden rounded-full bg-muted"
      >
        <MeterPrimitive.Indicator
          data-slot="meter-indicator"
          className={cn("bg-primary transition-[width]", indicatorClassName)}
        />
      </MeterPrimitive.Track>
    </MeterPrimitive.Root>
  )
}

export { Meter }
