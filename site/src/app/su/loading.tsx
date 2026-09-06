import { Skeleton } from "@/components/ui/skeleton";

// What a page's slot shows from the moment a rail link is clicked until the
// page arrives. Every surface opens on cards, so the stand-in is a row of
// them; the page's own skeletons take over once it mounts.
export default function SuLoading() {
  return (
    <div className="grid gap-4 pt-1 sm:grid-cols-2 lg:grid-cols-3">
      {Array.from({ length: 3 }, (_, i) => (
        <Skeleton key={i} className="h-[104px] rounded-xl" />
      ))}
      <Skeleton className="h-96 rounded-xl sm:col-span-2 lg:col-span-3" />
    </div>
  );
}
