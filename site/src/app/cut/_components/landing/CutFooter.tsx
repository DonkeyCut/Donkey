"use client";

import Link from "next/link";

import { GITHUB_REPO_URL } from "@/app/_components/landing/data";

type FooterLink = { href: string; label: string };
type FooterColumn = { title: string; links: FooterLink[] };

const DISCORD_URL = "https://discord.gg/Xv6qGax7sT";

// Cut's own footer, in the shared landing Footer's grouped-column design. The
// shared Footer links routes that don't exist on donkeycut.com (/sign-in,
// /use-cases), so this one carries only links that resolve on both hosts.
export function CutFooter() {
  const linkGroups: FooterColumn[] = [
    {
      title: "Product",
      links: [
        { href: GITHUB_REPO_URL, label: "GitHub" },
        { href: DISCORD_URL, label: "Discord" },
      ],
    },
    {
      title: "Legal",
      links: [
        { href: "/privacy", label: "Privacy Policy" },
        { href: "/terms", label: "Terms of Use" },
      ],
    },
  ];

  return (
    <footer className="w-full border-t-2 border-ink py-16 md:py-[80px]">
      <div className="mx-auto flex max-w-[1400px] flex-col gap-12 px-6 md:flex-row md:flex-wrap md:gap-x-24 md:px-12">
        <div className="min-w-[240px] max-w-sm flex-1">
          <Link
            href="/"
            aria-label="Donkey Cut home"
            className="text-[40px] font-semibold text-ink no-underline md:text-[48px]"
          >
            Donkey Cut
          </Link>
          <p className="mt-6 text-[15px] font-semibold text-ink">
            Need help? Join us on{" "}
            <a
              href={DISCORD_URL}
              className="underline underline-offset-2"
            >
              Discord
            </a>
          </p>
          <p className="mt-6 text-[13px] text-[#666]">
            2026 Donkey, Inc.
          </p>
        </div>
        <div className="flex flex-1 flex-col gap-10 sm:flex-row sm:flex-wrap sm:gap-x-16 sm:gap-y-12 md:gap-x-20">
          {linkGroups.map((group) => (
            <div key={group.title} className="flex min-w-[140px] flex-col gap-4">
              <div className="text-[15px] font-semibold text-ink">
                {group.title}
              </div>
              <div className="flex flex-col gap-3">
                {group.links.map((link) => (
                  <Link
                    key={link.href}
                    href={link.href}
                    className="text-[15px] text-[#666] no-underline transition-colors hover:text-ink"
                  >
                    {link.label}
                  </Link>
                ))}
              </div>
            </div>
          ))}
        </div>
      </div>
    </footer>
  );
}
