"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { ArrowLeft, ChevronRight } from "lucide-react";

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
  SidebarProvider,
} from "@/components/ui/sidebar";
import { SU_APP_ORIGIN } from "@/cut/lib/hosts";

// The super-user section's left rail, the shadcn sidebar with the admin
// surfaces as its menu and a way back to the app pinned to the bottom. A
// section with tabs is a collapsible item that opens onto its tabs; it starts
// open while one of them is showing, and lands on its first tab when clicked.
export function SuSidebar() {
  const pathname = usePathname();
  const here = suSurfaceAt(pathname);

  return (
    <SidebarProvider className="min-h-0 w-auto shrink-0">
      <Sidebar collapsible="none" className="w-60 border-r border-sidebar-border">
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
          <span className="text-[17px] font-semibold tracking-tight">Super user</span>
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
                        className="h-9 px-2.5"
                      >
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
                            >
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
    </SidebarProvider>
  );
}
