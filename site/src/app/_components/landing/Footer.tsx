import { Link as LinkIcon, Play, Send, type LucideIcon } from "lucide-react";
import Link from "next/link";
import { getTranslations } from "next-intl/server";

import { GITHUB_REPO_URL } from "@/app/_components/landing/data";
import { LanguagePicker } from "@/components/LanguagePicker";
import { hasPublishedPosts } from "@/lib/blog/read";

type SocialLink = {
  href: string;
  icon: LucideIcon;
  label: string;
};

type FooterLink = { href: string; label: string };
type FooterColumn = { title: string; links: FooterLink[] };

export async function Footer() {
  const [showBlog, t] = await Promise.all([hasPublishedPosts(), getTranslations("common.footer")]);
  const socialLinks: SocialLink[] = [
    { href: "https://www.linkedin.com", icon: LinkIcon, label: "LinkedIn" },
    { href: "https://www.youtube.com", icon: Play, label: "YouTube" },
    { href: "https://twitter.com", icon: Send, label: "Twitter" },
  ];

  // Each entry renders as its own titled column in the footer.
  const linkGroups: FooterColumn[] = [
    {
      title: t("product"),
      links: [
        { href: GITHUB_REPO_URL, label: "GitHub" },
        ...(showBlog ? [{ href: "/blog", label: t("blog") }] : []),
      ],
    },
    {
      title: t("legal"),
      links: [
        { href: "/privacy", label: t("privacy") },
        { href: "/terms", label: t("terms") },
      ],
    },
  ];

  return (
    <footer className="w-full border-t-2 border-foreground py-16 md:py-[80px]">
      <div className="mx-auto flex max-w-[1400px] flex-col gap-12 px-6 md:flex-row md:flex-wrap md:gap-x-24 md:px-12">
        <div className="min-w-[240px] max-w-sm flex-1">
          <div className="mb-6 flex flex-wrap items-center gap-4">
            <Link
              href="/"
              aria-label={t("donkeyHome")}
              className="text-[40px] font-semibold text-foreground no-underline md:text-[48px]"
            >
              Donkey
            </Link>
            {socialLinks.map((link) => {
              const Icon = link.icon;

              return (
                <a
                  aria-label={link.label}
                  href={link.href}
                  key={link.label}
                  className="flex h-10 w-10 items-center justify-center rounded-lg border-2 border-foreground bg-card text-foreground no-underline"
                >
                  <Icon size={18} />
                </a>
              );
            })}
          </div>
          <p className="text-[15px] font-semibold text-foreground">
            {t.rich("helpEmail", {
              email: "hello@donkeycut.com",
              link: (chunks) => (
                <a href="mailto:hello@donkeycut.com" className="underline underline-offset-2">
                  {chunks}
                </a>
              ),
            })}
          </p>
          <p className="mt-6 text-[13px] text-foreground/70">
            {t("copyright")}
          </p>
          <div className="mt-6">
            <LanguagePicker placement="footer" />
          </div>
        </div>
        <div className="flex flex-1 flex-col gap-10 sm:flex-row sm:flex-wrap sm:gap-x-16 sm:gap-y-12 md:gap-x-20">
          {linkGroups.map((group) => (
            <div key={group.title} className="flex min-w-[140px] flex-col gap-4">
              <div className="text-[15px] font-semibold text-foreground">
                {group.title}
              </div>
              <div className="flex flex-col gap-3">
                {group.links.map((link) => (
                  <Link
                    key={link.href}
                    href={link.href}
                    className="text-[15px] text-foreground/70 no-underline transition-colors hover:text-foreground"
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
