"use client";

import { usePathname } from "next/navigation";

import { SU_NAV } from "@/app/su/nav";

// Every surface owns a path, so the match is exact; an address outside the
// rail falls back to the entry the section root opens.
export function SuHeader() {
  const pathname = usePathname();
  const section = SU_NAV.find((s) => s.href === pathname) ?? SU_NAV[0];
  return (
    <div className="sticky top-0 z-20 mx-auto flex w-full max-w-6xl shrink-0 items-start justify-between gap-4 bg-background px-10 pt-9 pb-5">
      <div>
        <h1 className="text-lg font-semibold tracking-tight">{section.title}</h1>
        {section.description ? (
          <p className="mt-1 text-sm text-muted-foreground">
            {section.description}
          </p>
        ) : null}
      </div>
      {section.Action ? <section.Action /> : null}
    </div>
  );
}
