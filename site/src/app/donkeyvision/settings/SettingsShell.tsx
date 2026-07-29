"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, type ReactNode } from "react";

import { useAppLoaded } from "@/lib/analytics";
import { authClient } from "@/lib/auth-client";
import { cn } from "@/lib/utils";
import { Skeleton } from "@/components/ui/skeleton";

const navItems = [
  { href: "/donkeyvision/settings/usage", label: "Usage" },
  { href: "/donkeyvision/settings/api-keys", label: "API keys" },
];

// The Donkey Vision settings: API keys and usage for the Vision API. Donkey
// Cut has its own billing and usage pages inside the Cut app
// (src/app/cut/app/(home)/settings).
// The settings UI is fully client-rendered. We guard on the client session and,
// if signed out, send the user to Google sign-in (API routes also enforce auth).
export function SettingsShell({ children }: { children: ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  const { data: session, isPending } = authClient.useSession();

  useAppLoaded("settings", session?.user);

  useEffect(() => {
    if (!isPending && !session) {
      void authClient.signIn.social({
        callbackURL: "/donkeyvision/settings",
        provider: "google",
      });
    }
  }, [isPending, session]);

  if (isPending || !session) {
    return (
      <div className="mx-auto max-w-5xl px-6 py-16">
        <Skeleton className="h-8 w-48" />
        <Skeleton className="mt-6 h-40 w-full" />
      </div>
    );
  }

  return (
    <div className="min-h-screen">
      <header className="border-b">
        <div className="mx-auto flex max-w-5xl items-center justify-between px-6 py-4">
          <Link className="flex items-center gap-2 text-lg font-semibold" href="/donkeyvision">
            <div className="flex h-8 w-8 items-center justify-center overflow-hidden rounded-md">
              <img
                src="/donkey-logo.svg"
                alt="Donkey Logo"
                width={32}
                height={32}
                className="block h-full w-full object-contain"
              />
            </div>
            <span>Donkey</span>
          </Link>
          <nav className="flex items-center gap-1">
            {navItems.map((item) => (
              <Link
                key={item.href}
                href={item.href}
                className={cn(
                  "rounded-md px-3 py-1.5 text-sm font-medium transition-colors",
                  pathname === item.href
                    ? "bg-muted text-foreground"
                    : "text-muted-foreground hover:text-foreground",
                )}
              >
                {item.label}
              </Link>
            ))}
            <button
              type="button"
              onClick={() => {
                // Sign out everywhere: revoke every session for this user (so the Mac app signs out
                // too), then clear this browser's session and leave. signOut + redirect always run,
                // even if the revoke call fails, so the user is never stranded signed-in locally.
                void (async () => {
                  try {
                    await authClient.revokeSessions();
                  } finally {
                    await authClient.signOut();
                    router.push("/");
                  }
                })();
              }}
              className="ml-2 rounded-md px-3 py-1.5 text-sm font-medium text-muted-foreground hover:text-foreground"
            >
              Sign out
            </button>
          </nav>
        </div>
      </header>
      <main className="mx-auto max-w-5xl px-6 py-10">{children}</main>
    </div>
  );
}
