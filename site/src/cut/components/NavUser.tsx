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
import { cutInstallHref } from "@/cut/lib/install";
import { openOnboarding } from "@/cut/lib/onboarding";
import { useCutBase } from "@/cut/lib/nav";
import { authClient } from "@/lib/auth-client";
import { useAccountProfile, visibleName } from "@/queries/accountProfile";

// Signed-in user row pinned to the sidebar bottom; the whole row opens the
// account menu. Hidden while signed out — the editor itself needs no account,
// so the row only surfaces once a session exists.
export function NavUser() {
  const router = useRouter();
  const base = useCutBase();
  const { data: session } = authClient.useSession();
  // Mounted above the session check so the hook order is stable; it stays idle
  // until there's a session to read a profile for.
  const { data: profile, isPending } = useAccountProfile({ enabled: Boolean(session) });
  if (!session) return null;

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
  const name = visibleName(profile, session.user.name);
  const image = profile?.image ?? session.user.image;
  const root = base.replace(/\/app$/, "");

  const signOut = () => {
    // Sign out everywhere: revoke every session for this user (so the Mac app
    // signs out too), then clear this browser's session and land on the Cut
    // landing page. signOut + redirect always run, even if the revoke fails,
    // so the user is never stranded signed-in locally.
    void (async () => {
      try {
        await authClient.revokeSessions();
      } finally {
        await authClient.signOut();
        router.push(root || "/");
      }
    })();
  };

  return (
    <DropdownMenu>
      <DropdownMenuTrigger className="flex w-full items-center gap-2.5 rounded-lg px-2 py-1.5 text-left transition-colors hover:bg-muted data-[popup-open]:bg-muted">
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
        {/* The install page lives outside the editor, so it opens in its own
            tab rather than navigating away from an open project. */}
        <DropdownMenuItem
          onClick={() => window.open(cutInstallHref(root), "_blank", "noopener")}
        >
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
