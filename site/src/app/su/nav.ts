// The super-user surfaces in rail order, addressed from the root of their own
// host. One entry carries what a surface is drawn from — the rail's tab and
// the header's title — so adding a surface is one edit here and a page.tsx;
// the rail keeps the icons and the header keeps the actions, keyed by
// address, because the proxy imports this file and it has to stay free of
// React. The host opens on the first entry, so reordering this list moves
// where it opens.
//
// A surface with tabs is a section: its href is a folder and each tab is a
// page under it. A section address opens its first tab, answered by the proxy
// before any route runs (suSectionHome). The rail opens the tabs beneath the
// section while any of them is showing.
type SuTabShape = {
  href: string;
  label: string;
};

type SuSurfaceShape = SuTabShape & {
  title: string;
  tabs?: readonly SuTabShape[];
};

export const SU_NAV = [
  {
    href: "/analytics",
    label: "Analytics",
    title: "Analytics",
    tabs: [
      { href: "/analytics/product", label: "Product" },
      { href: "/analytics/social", label: "Social" },
    ],
  },
  {
    href: "/users",
    label: "Users",
    title: "Users",
  },
  {
    href: "/credits",
    label: "Credits",
    title: "Credits",
  },
  {
    href: "/product",
    label: "Product",
    title: "Product",
  },
  {
    href: "/outreach",
    label: "Outreach",
    title: "Outreach",
  },
  {
    href: "/promotions",
    label: "Promotions",
    title: "Promotions",
  },
  {
    href: "/blog",
    label: "Blog",
    title: "Blog",
  },
  {
    href: "/experiments",
    label: "Experiments",
    title: "Experiments",
    tabs: [
      {
        href: "/experiments/list",
        label: "Tests",
      },
      {
        href: "/experiments/settings",
        label: "Settings",
      },
    ],
  },
  {
    href: "/jobs",
    label: "Jobs",
    title: "Jobs",
    tabs: [
      {
        href: "/jobs/email",
        label: "Email",
      },
      {
        href: "/jobs/list",
        label: "Background",
      },
    ],
  },
] as const satisfies readonly SuSurfaceShape[];

export type SuSurface = (typeof SU_NAV)[number];
export type SuTab = Extract<SuSurface, { tabs: unknown }>["tabs"][number];
/** Every address the rail can open: a tab, or a surface without tabs. */
export type SuPage = SuTab | SuSurface;

export const suTabs = (surface: SuSurface): readonly SuTab[] | undefined =>
  "tabs" in surface ? surface.tabs : undefined;

// The surface an address belongs to, and the page within it: the tab showing,
// or the surface itself when it has none. A section address resolves to its
// first tab, the one the proxy opens it on; an address outside the rail falls
// back to the entry the host opens on.
export function suSurfaceAt(pathname: string): { surface: SuSurface; page: SuPage } {
  const surface =
    SU_NAV.find((s) => pathname === s.href || pathname.startsWith(`${s.href}/`)) ??
    SU_NAV[0];
  const tabs = suTabs(surface);
  const page = tabs?.find((t) => t.href === pathname) ?? tabs?.[0] ?? surface;
  return { surface, page };
}

// Where an address that is not itself a page opens: the host root lands on
// the first entry, and a section on its first tab. Null for a page address.
export function suSectionHome(pathname: string): string | null {
  const surface = pathname === "/" ? SU_NAV[0] : SU_NAV.find((s) => s.href === pathname);
  if (!surface) return null;
  const tabs = suTabs(surface);
  if (tabs) return tabs[0].href;
  return pathname === "/" ? surface.href : null;
}
