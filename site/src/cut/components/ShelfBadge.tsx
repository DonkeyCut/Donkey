import { Cloud, Laptop } from "lucide-react";
import { useTranslations } from "next-intl";
import { useLabels } from "@/i18n/labels";
import type { Residency } from "@/cut/lib/residency";

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
  const t = useTranslations("home.shelfBadge");
  const residencyLabel = useLabels("residency");
  const Icon = residency === "cloud" ? Cloud : Laptop;
  return (
    <span
      title={
        offline
          ? t("offline")
          : residencyLabel(residency)
      }
      className={className}
    >
      <Icon className="size-3" />
    </span>
  );
}
