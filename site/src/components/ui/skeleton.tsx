import { cn } from "@/lib/utils"

// The slab, its breathing, and the highlight sweeping across it live in
// globals.css keyed on data-slot, so every skeleton in the app shimmers.
function Skeleton({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="skeleton"
      className={cn("rounded-md bg-[var(--skeleton)]", className)}
      {...props}
    />
  )
}

export { Skeleton }
