"use client";

import Image from "next/image";
import { usePathname } from "next/navigation";
import { useCallback, useEffect, useState, type ReactNode } from "react";
import { Loader2 } from "lucide-react";

import { DONKEY_DOWNLOAD_URL } from "@/app/_components/landing/data";
import { track } from "@/lib/analytics";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  ENGINE_LOST_EVENT,
  engineConnect,
  engineGateOpen,
  engineProbe,
  servedFromEngine,
} from "@/cut/lib/api";
import { announceLocalCompute, setCutMode } from "@/cut/lib/backend";

// Which backend the app starts on, decided once per load. Chrome gates a
// public https page's first fetch to 127.0.0.1 behind its Local Network Access
// prompt — "donkeycut.com wants to access other apps and services on this
// device" — so the engine is probed only when that costs nothing: the page is
// served by the engine itself, or the permission is already granted.
// Otherwise the app starts in the cloud. The api.ts latch keeps app code off
// loopback until a probe succeeds, so the prompt can never ambush a login.
//
// Nothing here blocks the app. Cloud editing always works, so a Mac with no
// engine reachable is a working editor, not a wall. What it is not is silent:
// a browser that has reached this Mac's engine before and can't now gets a
// banner it can't dismiss — its local projects are the ones that won't open —
// and the banner opens the recovery instructions in a dialog. The gate keeps
// probing behind the banner, so starting the Donkey app clears it. Engine
// loss mid-session (api.ts's engineLost) lands in the same state.
const ACK_KEY = "cut-engine-connect-acked";
// Set the first time an engine answers in this browser. It separates a Mac
// user whose app is missing from a browser that never had one, which is the
// difference between a banner worth showing and noise.
const SEEN_KEY = "cut-engine-seen";

/** Dev-only preview of the banner and its dialog, since localhost always
 * reaches its engine: ?gate=ask (connect ask) | install (get-the-app variant)
 * | blocked. Compiled out of production builds. */
function forcedGate(): string | null {
  if (process.env.NODE_ENV === "production") return null;
  return new URLSearchParams(window.location.search).get("gate");
}

/** The browser's local-network permission state, null where the permission
 * (or the query) doesn't exist — non-Chrome browsers, older Chrome. */
async function permissionState(): Promise<PermissionState | null> {
  try {
    const status = await navigator.permissions.query({
      name: "local-network-access" as PermissionName,
    });
    return status.state;
  } catch {
    return null;
  }
}

export function ConnectGate({ children }: { children: ReactNode }) {
  // Settings pages (billing, usage, feature flags) never touch the engine, so
  // they skip the probe and the banner.
  const onSettings = (usePathname() ?? "").split("/").includes("settings");
  // Whether the engine on this Mac is reachable right now.
  const [reached, setReached] = useState<boolean | null>(null);
  // This browser has used the engine before, so an unreachable one is news.
  const [seen, setSeen] = useState(false);
  // Whether connecting would raise the browser's permission prompt. True keeps
  // every automatic probe off loopback: the prompt fires from a click or not
  // at all.
  const [needsAsk, setNeedsAsk] = useState(false);
  // The permission is denied — no probe can recover it, only site settings.
  const [blocked, setBlocked] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [howOpen, setHowOpen] = useState(false);

  const bindEngine = useCallback(() => {
    localStorage.setItem(SEEN_KEY, "1");
    setSeen(true);
    setBlocked(false);
    setCutMode("local");
    engineGateOpen();
    announceLocalCompute();
    setReached(true);
  }, []);

  const bindCloud = useCallback(() => {
    setCutMode("cloud");
    announceLocalCompute();
    setReached(false);
  }, []);

  const check = useCallback(async () => {
    const forced = forcedGate();
    if (forced) {
      setSeen(true);
      setNeedsAsk(forced === "ask");
      setBlocked(forced === "blocked");
      return bindCloud();
    }
    const perm = await permissionState();
    setSeen(localStorage.getItem(SEEN_KEY) === "1");
    setBlocked(perm === "denied");
    const quiet =
      servedFromEngine() ||
      perm === "granted" ||
      (perm === null && localStorage.getItem(ACK_KEY) === "1");
    setNeedsAsk(!quiet && perm !== "denied");
    if (quiet) {
      try {
        await engineProbe();
        return bindEngine();
      } catch {
        // No engine on this Mac; the cloud is the working half.
      }
    }
    bindCloud();
  }, [bindCloud, bindEngine]);

  useEffect(() => {
    if (onSettings) return;
    void check();
  }, [check, onSettings]);

  // Keep probing behind the banner so the app connects the moment the engine
  // appears. Both skips are permanent conditions, not slow ones: a pending
  // permission would turn the probe into a prompt, and a denied one can only
  // be undone in site settings.
  useEffect(() => {
    if (reached !== false || needsAsk || blocked || forcedGate()) return;
    const t = setInterval(() => {
      engineProbe().then(bindEngine, () => {});
    }, 3000);
    return () => clearInterval(t);
  }, [reached, needsAsk, blocked, bindEngine]);

  // The engine stopped answering mid-session: fall back to the cloud and raise
  // the banner. The poll above restores the app when the engine returns.
  useEffect(() => {
    const onLost = () => {
      setSeen(true);
      bindCloud();
    };
    window.addEventListener(ENGINE_LOST_EVENT, onLost);
    return () => window.removeEventListener(ENGINE_LOST_EVENT, onLost);
  }, [bindCloud]);

  const connect = async () => {
    setConnecting(true);
    localStorage.setItem(ACK_KEY, "1");
    const ok = await engineConnect();
    setConnecting(false);
    if (ok) {
      setHowOpen(false);
      return bindEngine();
    }
    // No engine answered, but the browser ask may still have been decided.
    const perm = await permissionState();
    setBlocked(perm === "denied");
    setNeedsAsk(perm === "prompt");
  };

  // The banner reports a fact about this browser, so it stays up until the
  // engine answers; the instructions behind it are a dialog the user closes.
  const banner = reached === false && seen && !onSettings;

  // The banner takes its 32px out of the viewport rather than pushing the app
  // past it: the surfaces below fill this column's remaining height (h-full),
  // so the editor lays out against the space it actually has.
  return (
    <div className="flex h-screen flex-col">
      {banner && (
        <div className="flex h-8 shrink-0 items-center justify-center gap-3 bg-red-600 px-4 text-xs font-medium text-white">
          <span className="min-w-0 truncate">
            {blocked
              ? "Your browser is blocking this page from reaching the Donkey app on this Mac."
              : "Donkey Cut can’t reach the Donkey app on this Mac."}{" "}
            Projects stored on this Mac won’t open.
          </span>
          <button
            className="shrink-0 underline underline-offset-2"
            onClick={() => setHowOpen(true)}
            type="button"
          >
            How to fix this
          </button>
        </div>
      )}
      <div className="min-h-0 flex-1">{children}</div>
      <Dialog open={howOpen} onOpenChange={setHowOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>
              {blocked
                ? "Connection blocked"
                : needsAsk
                  ? "Connect to the Donkey app"
                  : "Donkey Cut works with the Donkey Mac app"}
            </DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">
            {blocked ? (
              <>
                Your browser is blocking this page from reaching the Donkey app
                on this Mac. Open the site settings from the icon next to the
                address bar, turn on{" "}
                <span className="font-medium text-foreground">Apps on device</span>,
                then try again.
              </>
            ) : needsAsk ? (
              <>
                Donkey Cut runs locally in the Donkey app on this Mac. Your
                browser will ask for permission to connect to apps on this
                device — choose{" "}
                <span className="font-medium text-foreground">Allow</span>.
              </>
            ) : (
              <>
                Everything runs locally on your Mac. Install Donkey, or open it
                if it&rsquo;s already installed — this page connects
                automatically.
              </>
            )}
          </p>
          {blocked && (
            <Image
              alt="Chrome's site settings open over the address bar, with the Apps on device toggle"
              className="w-full rounded-xl border shadow-sm"
              height={660}
              src="/cut/connect-site-settings.png"
              unoptimized
              width={970}
            />
          )}
          {!blocked && !needsAsk && (
            <p className="text-xs text-muted-foreground">
              Don&rsquo;t have the Donkey app yet?{" "}
              <a
                className="font-medium text-foreground underline underline-offset-2"
                href={DONKEY_DOWNLOAD_URL}
                onClick={() => track("app_install_clicked", { source: "connect_gate_link" })}
              >
                Install it for Mac
              </a>
            </p>
          )}
          <DialogFooter className="mt-2">
            {!blocked && !needsAsk && (
              <Button
                variant="outline"
                onClick={() => {
                  track("app_install_clicked", { source: "connect_gate_button" });
                  window.location.href = DONKEY_DOWNLOAD_URL;
                }}
              >
                Download for Mac
              </Button>
            )}
            <Button onClick={() => void connect()} disabled={connecting}>
              {connecting && <Loader2 className="animate-spin" data-icon="inline-start" />}
              {connecting ? "Connecting…" : needsAsk ? "Connect" : "Try again"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
