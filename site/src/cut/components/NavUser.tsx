"use client";

import { useRouter } from "next/navigation";
import {
  ChartColumn,
  CreditCard,
  EllipsisVertical,
  Flag,
  LogOut,
  MonitorDown,
} from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cutInstallHref } from "@/cut/lib/install";
import { useCutBase } from "@/cut/lib/nav";
import { authClient } from "@/lib/auth-client";

function Avatar({ name, image }: { name: string; image: string | null | undefined }) {
  if (image) {
    return <img src={image} alt="" className="size-8 shrink-0 rounded-lg object-cover" />;
  }
  return (
    <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-muted text-sm font-semibold text-muted-foreground">
      {(name.trim()[0] ?? "?").toUpperCase()}
    </span>
  );
}

// Signed-in user row pinned to the sidebar bottom; the whole row opens the
// account menu. Hidden while signed out — the editor itself needs no account,
// so the row only surfaces once a session exists.
export function NavUser() {
  const router = useRouter();
  const base = useCutBase();
  const { data: session } = authClient.useSession();
  if (!session) return null;

  const { name, email, image } = session.user;
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
      <DropdownMenuTrigger className="mt-auto flex w-full items-center gap-2.5 rounded-lg px-2 py-1.5 text-left transition-colors hover:bg-muted data-[popup-open]:bg-muted">
        <Avatar name={name} image={image} />
        <span className="min-w-0 flex-1 leading-tight">
          <span className="block truncate text-sm font-medium">{name}</span>
          <span className="block truncate text-xs text-muted-foreground">{email}</span>
        </span>
        <EllipsisVertical className="size-4 shrink-0 text-muted-foreground" />
      </DropdownMenuTrigger>
      <DropdownMenuContent side="top" align="start" className="w-56">
        {/* GroupLabel must live inside a Group in this menu kit. */}
        <DropdownMenuGroup>
          <DropdownMenuLabel className="flex items-center gap-2.5 font-normal">
            <Avatar name={name} image={image} />
            <span className="min-w-0 flex-1 leading-tight">
              <span className="block truncate text-sm font-medium">{name}</span>
              <span className="block truncate text-xs text-muted-foreground">{email}</span>
            </span>
          </DropdownMenuLabel>
        </DropdownMenuGroup>
        <DropdownMenuSeparator />
        <DropdownMenuItem onClick={() => router.push(`${base}/settings`)}>
          <CreditCard /> Billing
        </DropdownMenuItem>
        <DropdownMenuItem onClick={() => router.push(`${base}/settings/usage`)}>
          <ChartColumn /> Usage
        </DropdownMenuItem>
        {/* The install page lives outside the editor, so it opens in its own
            tab rather than navigating away from an open project. */}
        <DropdownMenuItem
          onClick={() => window.open(cutInstallHref(root), "_blank", "noopener")}
        >
          <MonitorDown /> Run Donkey Cut locally
        </DropdownMenuItem>
        <DropdownMenuItem onClick={() => router.push(`${base}/settings/flags`)}>
          <Flag /> Feature flags
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem onClick={signOut}>
          <LogOut /> Log out
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
