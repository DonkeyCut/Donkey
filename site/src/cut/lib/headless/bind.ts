import { bindCutMode } from "../backend";
import { bindCloudSession } from "../backend/cloud";
import { bindHostedSession } from "../hosted";

// One call wires a headless process to the hosted site as one user: the
// backend mode pins to cloud, and both transports — the cut-cloud driver and
// the hosted inference chokepoint — fold the session's origin and auth
// headers into every request. After this, the same lib code the page runs
// (tools, generation, media import) reaches the right server on its own.

export interface HeadlessSession {
  /** Absolute origin of the hosted site, e.g. https://donkeycut.com. */
  base: string;
  /** Auth folded into every request: a session cookie, the runner grant, or
   * the dev bypass. */
  headers: Record<string, string>;
}

export function bindHeadlessSession(session: HeadlessSession): void {
  bindCutMode("cloud");
  bindCloudSession(session.base, session.headers);
  bindHostedSession(session.base, session.headers);
}
