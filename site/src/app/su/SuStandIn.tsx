import { Skeleton } from "@/components/ui/skeleton";

// What a page's slot shows until its data is on screen. The route fallback
// (loading.tsx) and every page's pending branch draw this same stand-in, so
// the handoff from one to the other paints the same pixels: a page arriving
// before its query resolves is invisible.
export function SuStandIn() {
  return (
    <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
      {Array.from({ length: 3 }, (_, i) => (
        <Skeleton key={i} className="h-[104px] rounded-xl" />
      ))}
      <Skeleton className="h-96 rounded-xl sm:col-span-2 lg:col-span-3" />
    </div>
  );
}
