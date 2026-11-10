"use client";

import { useAssetDrop, type RefTake } from "@/cut/lib/assetRef";
import { cn } from "@/lib/utils";

/** Wrap any element to make it a media drop target for both transports: HTML5
 * card drags and pointer drags (timeline clips). The callback receives the
 * dragged ref; filter by `ref.scope` for targets that only take some sources. */
export function RefDropZone({
  onRef,
  className,
  activeClassName,
  children,
}: {
  onRef: RefTake;
  className?: string;
  activeClassName?: string;
  children: React.ReactNode;
}) {
  const { active, attachTarget, targetProps } = useAssetDrop(onRef);
  return (
    <div ref={attachTarget} {...targetProps} className={cn(className, active && activeClassName)}>
      {children}
    </div>
  );
}
