"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ComponentType } from "react";

import { RunAnalyticsButton } from "@/app/su/analytics/RunAnalyticsButton";
import { NewPostButton } from "@/app/su/blog/NewPostButton";
import { DrainNowButton } from "@/app/su/jobs/email/DrainNowButton";
import { suSurfaceAt, type SuPage } from "@/app/su/nav";
import { useSuCrumbValue } from "@/app/su/SuCrumb";
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "@/components/ui/breadcrumb";
import { ScanOutreachButton } from "@/app/su/outreach/ScanOutreachButton";
import { SidebarTrigger } from "@/components/ui/sidebar";

// The action a page carries in its header, keyed by the page's address. The
// rail's list (nav.ts) stays free of React so the proxy can read it, so the
// components live here.
const PAGE_ACTIONS: Partial<Record<SuPage["href"], ComponentType>> = {
  "/analytics/product": RunAnalyticsButton,
  "/blog": NewPostButton,
  "/jobs/email": DrainNowButton,
  "/outreach": ScanOutreachButton,
};

// The title is the surface's; the description and action belong to whichever
// page is showing, since a section's tabs each drive their own work. The
// header carries the button that shows and hides the rail (also ⌘B).
export function SuHeader() {
  const pathname = usePathname();
  const { surface, page } = suSurfaceAt(pathname);
  const Action = PAGE_ACTIONS[page.href];
  const crumb = useSuCrumbValue();
  return (
    <div className="sticky top-0 z-20 mx-auto flex w-full max-w-6xl shrink-0 items-start justify-between gap-4 bg-background px-4 pt-4 pb-4 md:px-10 md:pt-9">
      <div className="flex min-w-0 items-start gap-2">
        <SidebarTrigger className="-ml-1.5 shrink-0" />
        <div className="min-w-0">
          {crumb ? (
            <Breadcrumb>
              <BreadcrumbList className="text-lg font-semibold tracking-tight">
                <BreadcrumbItem>
                  <BreadcrumbLink render={<Link href={surface.href} />}>{surface.title}</BreadcrumbLink>
                </BreadcrumbItem>
                <BreadcrumbSeparator />
                <BreadcrumbItem>
                  <BreadcrumbPage className="truncate">{crumb}</BreadcrumbPage>
                </BreadcrumbItem>
              </BreadcrumbList>
            </Breadcrumb>
          ) : (
            <h1 className="text-lg font-semibold tracking-tight">
              {surface.title}
            </h1>
          )}
          {"description" in page && page.description ? (
            <p className="mt-1 text-sm text-muted-foreground">
              {page.description}
            </p>
          ) : null}
        </div>
      </div>
      {Action ? <Action /> : null}
    </div>
  );
}
