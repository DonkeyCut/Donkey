"use client";

// The user-triggered path onto this Mac's engine. The ConnectGate's quiet
// probe only runs when it costs nothing, so a browser with no memory of the
// app — a fresh profile, a private window — starts in the cloud with no
// automatic way back. Any surface can offer that way instead: this connect is
// run from a click, so the browser's local-network prompt lands in context,
// and a success binds the whole app to the engine exactly as the gate's own
// probe would. The gate listens for ENGINE_CONNECTED_EVENT to fold the result
// into its banner state.
import { engineConnect, engineGateOpen } from "./api";
import { announceLocalCompute, setCutMode } from "./backend";
import { setNeedsApp } from "./needsApp";
import { markEngineSeen } from "./residency";

// Set on the first user-approved connect; lets browsers without the
// local-network permission API (where a loopback probe never prompts) probe
// quietly on later visits.
export const CONNECT_ACK_KEY = "cut-engine-connect-acked";

/** Fired on window when a user-triggered connect reached the engine. */
export const ENGINE_CONNECTED_EVENT = "cut-engine-connected";

/**
 * Connect to the engine from a user gesture. Resolves true once the app is
 * bound to the engine — mode set, gate latch open, listeners notified — and
 * false when no engine answered (not installed, not running, or the browser
 * ask was declined).
 */
export async function connectToEngine(): Promise<boolean> {
  try {
    localStorage.setItem(CONNECT_ACK_KEY, "1");
  } catch {
    // Private mode: the ask repeats next visit.
  }
  if (!(await engineConnect())) return false;
  markEngineSeen();
  setNeedsApp(false);
  setCutMode("local");
  engineGateOpen();
  announceLocalCompute();
  window.dispatchEvent(new Event(ENGINE_CONNECTED_EVENT));
  return true;
}
