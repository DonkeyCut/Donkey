import { Cloud, Laptop } from "lucide-react";
import { RESIDENCY_LABEL, type Residency } from "@/cut/lib/residency";

/** Which shelf an item sits on, on its card. The library merges both, so the
 * badge is how you tell a clip on this Mac from one in the cloud — and, when
 * the app isn't answering, why that clip is showing but not usable. */
export function ShelfBadge({
  residency,
  offline = false,
  className,
}: {
  residency: Residency;
  offline?: boolean;
  className?: string;
}) {
  const Icon = residency === "cloud" ? Cloud : Laptop;
  return (
    <span
      title={
        offline
          ? "Local — open the Donkey app to use it"
          : RESIDENCY_LABEL[residency]
      }
      className={className}
    >
      <Icon className="size-3" />
    </span>
  );
}
