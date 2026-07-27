import { DONKEYCUT_CANONICAL } from "@/cut/lib/hosts";

// Where "get the Mac app" points. The install page is served on donkeycut.com
// and local dev only, so anywhere the Cut tree runs unrewritten — the hosted
// apex, where in-app links carry a "/cut" root — the link leaves for the
// canonical host.
export function cutInstallHref(root: string): string {
  return root ? `${DONKEYCUT_CANONICAL}/install` : "/install";
}
