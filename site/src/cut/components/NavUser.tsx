"use client";

import { useRouter } from "next/navigation";
import {
  ChartColumn,
  ChevronRight,
  CreditCard,
  EllipsisVertical,
  LogOut,
  MonitorDown,
  Sparkles,
} from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Skeleton } from "@/components/ui/skeleton";
import { UserAvatar } from "@/cut/components/UserAvatar";
import { forgetRememberedEngineUser } from "@/cut/lib/api";
import { useEngineUser } from "@/cut/lib/backend/hooks";
import { connectToEngine } from "@/cut/lib/connect";
import { cutInstallHref } from "@/cut/lib/install";
import { openOnboarding } from "@/cut/lib/onboarding";
import { useCutBase } from "@/cut/lib/nav";
import { authClient } from "@/lib/auth-client";
import { useAccountProfile, visibleName } from "@/queries/accountProfile";

// Signed-in user row pinned to the sidebar bottom; the whole row opens the
// account menu. Hidden while signed out — the editor itself needs no account,
// so the row only surfaces once an account is bound.
//
// Whether to draw the row comes from that binding, not from the session
// object: the auth client re-reads the session on every window focus and
// reports null while the request is in the air, which took the row off the
// sidebar and put it back a moment later. The session is read here only for
// the name and picture the provider gave us, and only until the profile —
// which holds both, and is cached — answers.
export function NavUser() {
  const router = useRouter();
  const base = useCutBase();
  const user = useEngineUser();
  const { data: session } = authClient.useSession();
  // Mounted above the account check so the hook order is stable; it stays idle
  // until there's an account to read a profile for.
  const { data: profile, isPending } = useAccountProfile({ enabled: Boolean(user) });
  if (!user) return null;

  // The name and picture the user chose live in the profile, not the session.
  // The row waits for them behind a skeleton of its own shape rather than
  // painting the provider's name and swapping it out a beat later.
  if (isPending) {
    return (
      <div className="flex w-full items-center gap-2.5 px-2 py-1.5">
        <Skeleton className="size-8 rounded-lg" />
        <Skeleton className="h-3.5 w-24" />
      </div>
    );
  }

  // The name the user chose wins over the one the provider gave us.
  const name = visibleName(profile, session?.user.name ?? "");
  const image = profile?.image ?? session?.user.image;

  const runLocally = () => {
    // Reach for the engine first — the app may already be installed and
    // running, and this click is the browser-permission ask landing in
    // context. Only when nothing answers does the install page open; without
    // noopener so a popup-blocked open (the permission ask can outlive the
    // click's activation window) is detectable and falls back to this tab.
    void connectToEngine().then((ok) => {
      if (ok) return;
      const tab = window.open(cutInstallHref(), "_blank");
      if (!tab) window.location.assign(cutInstallHref());
    });
  };

  const signOut = () => {
    // Sign out everywhere: revoke every session for this user (so the Mac app
    // signs out too), then clear this browser's session and land on the Cut
    // landing page. signOut + redirect always run, even if the revoke fails,
    // so the user is never stranded signed-in locally.
    void (async () => {
      try {
        await authClient.revokeSessions();
      } finally {
        forgetRememberedEngineUser();
        await authClient.signOut();
        router.push("/");
      }
    })();
  };

  return (
    <DropdownMenu>
      <DropdownMenuTrigger className="flex w-full cursor-pointer items-center gap-2.5 rounded-lg px-2 py-1.5 text-left transition-colors hover:bg-muted data-[popup-open]:bg-muted">
        <UserAvatar name={name} image={image} />
        <span className="min-w-0 flex-1 truncate text-sm font-medium">{name}</span>
        <EllipsisVertical className="size-4 shrink-0 text-muted-foreground" />
      </DropdownMenuTrigger>
      <DropdownMenuContent side="top" align="start" className="w-56">
        {/* The identity row is the way into the profile, where the account's
            details live and the display name is edited. */}
        <DropdownMenuGroup>
          <DropdownMenuItem
            className="gap-2.5 py-2"
            onClick={() => router.push(`${base}/settings/profile`)}
          >
            <UserAvatar name={name} image={image} />
            <span className="min-w-0 flex-1 truncate text-sm font-medium">{name}</span>
            <ChevronRight className="size-4 shrink-0 text-muted-foreground" />
          </DropdownMenuItem>
        </DropdownMenuGroup>
        <DropdownMenuSeparator />
        <DropdownMenuItem onClick={() => router.push(`${base}/settings`)}>
          <CreditCard /> Billing
        </DropdownMenuItem>
        <DropdownMenuItem onClick={() => router.push(`${base}/settings/usage`)}>
          <ChartColumn /> Usage
        </DropdownMenuItem>
        {/* The welcome sequence is a full-window overlay mounted in the app
            shell, so this asks for it rather than routing anywhere. */}
        <DropdownMenuItem onClick={openOnboarding}>
          <Sparkles /> View onboarding
        </DropdownMenuItem>
        <DropdownMenuItem onClick={runLocally}>
          <MonitorDown /> Run locally on Mac
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem onClick={signOut}>
          <LogOut /> Log out
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
