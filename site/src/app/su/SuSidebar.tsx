"use client";

import Link, { useLinkStatus } from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { ArrowLeft, ChevronRight } from "lucide-react";
import { useEffect } from "react";

import { SU_NAV, suSurfaceAt } from "@/app/su/nav";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuSub,
  SidebarMenuSubButton,
  SidebarMenuSubItem,
  useSidebar,
} from "@/components/ui/sidebar";
import { SU_APP_ORIGIN } from "@/cut/lib/hosts";

// Every page the rail can open. A section's own address redirects to its
// first tab, so the tabs are the pages.
const RAIL_PAGES = SU_NAV.flatMap((surface) =>
  surface.tabs ? surface.tabs.map((tab) => tab.href) : [surface.href],
);

/** The clicked row's answer while its page is on the way: the accent fill,
 * breathing. A link only shows its pending state when the page was not
 * prefetched, so a warmed click skips straight to the page. Rendered inside
 * the link, which is where the status is read from. */
function PendingFill() {
  const { pending } = useLinkStatus();
  return (
    <span
      aria-hidden
      data-pending={pending || undefined}
      className="pointer-events-none absolute inset-0 -z-10 rounded-md bg-sidebar-accent opacity-0 transition-opacity data-pending:animate-pulse data-pending:opacity-100"
    />
  );
}

// The super-user section's left rail, the shadcn sidebar with the admin
// surfaces as its menu and a way back to the app pinned to the bottom. A
// section with tabs is a collapsible item that opens onto its tabs; it starts
// open while one of them is showing, and lands on its first tab when clicked.
//
// On a wide screen the rail is a fixed column that never collapses. Under the
// sidebar's mobile breakpoint it becomes a sheet, opened from the header and
// closed by the navigation it triggers.
//
// Every page is prefetched when the rail mounts. A link prefetches itself
// once it is on screen, which leaves the tabs of a closed section cold until
// the section opens — and a click right after opening it beat the prefetch,
// so the page arrived from the server with nothing on screen in between.
export function SuSidebar() {
  const pathname = usePathname();
  const router = useRouter();
  const here = suSurfaceAt(pathname);
  const { isMobile, setOpenMobile } = useSidebar();

  useEffect(() => {
    for (const href of RAIL_PAGES) router.prefetch(href);
  }, [router]);

  useEffect(() => {
    setOpenMobile(false);
  }, [pathname, setOpenMobile]);

  return (
    <Sidebar
      collapsible={isMobile ? "offcanvas" : "none"}
      className="hidden w-60 shrink-0 border-r border-sidebar-border md:flex"
    >
      <SidebarHeader className="mb-3 flex-row items-center gap-2.5 px-4 pt-4">
        <span className="grid size-9 shrink-0 place-items-center p-0.5">
          <img
            src="/donkey-logo.svg"
            alt="Donkey Cut"
            width={36}
            height={36}
            className="block h-full w-full object-contain"
          />
        </span>
        <span className="text-[17px] font-semibold tracking-tight">
          Super user
        </span>
      </SidebarHeader>

      <SidebarContent>
        <SidebarGroup>
          <SidebarMenu className="gap-0.5">
            {SU_NAV.map((surface) => {
              const { href, label, icon: Icon, tabs } = surface;
              const active = here.surface === surface;
              if (!tabs) {
                return (
                  <SidebarMenuItem key={label}>
                    <SidebarMenuButton
                      isActive={active}
                      render={<Link href={href} />}
                      className="relative isolate h-9 px-2.5"
                    >
                      <PendingFill />
                      <Icon />
                      <span>{label}</span>
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                );
              }
              return (
                <Collapsible
                  key={label}
                  defaultOpen={active}
                  className="group/collapsible"
                  render={<SidebarMenuItem />}
                >
                  <CollapsibleTrigger
                    render={<SidebarMenuButton className="h-9 px-2.5" />}
                  >
                    <Icon />
                    <span>{label}</span>
                    <ChevronRight className="ml-auto transition-transform duration-200 group-data-open/collapsible:rotate-90" />
                  </CollapsibleTrigger>
                  <CollapsibleContent>
                    <SidebarMenuSub>
                      {tabs.map((tab) => (
                        <SidebarMenuSubItem key={tab.href}>
                          <SidebarMenuSubButton
                            isActive={active && here.tab === tab}
                            render={<Link href={tab.href} />}
                            className="relative isolate"
                          >
                            <PendingFill />
                            <span>{tab.label}</span>
                          </SidebarMenuSubButton>
                        </SidebarMenuSubItem>
                      ))}
                    </SidebarMenuSub>
                  </CollapsibleContent>
                </Collapsible>
              );
            })}
          </SidebarMenu>
        </SidebarGroup>
      </SidebarContent>

      {/* The app is a different host, so this is a document load. */}
      <SidebarFooter>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton
              render={<a href={`${SU_APP_ORIGIN}/app`} />}
              className="h-9 px-2.5"
            >
              <ArrowLeft />
              <span>Back to app</span>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarFooter>
    </Sidebar>
  );
}
