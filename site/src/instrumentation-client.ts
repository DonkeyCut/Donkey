import posthog from "posthog-js";

import { isSuHost } from "@/cut/lib/hosts";

// Surfaces that composite video onto a canvas every frame never record session
// replay (see app/_components/NoSessionReplay.tsx): the Cut app and the shared
// player, at their public paths and at the /cut/… routes the proxy serves them
// from. Disabling at init keeps the recorder script from loading at all on a
// direct load; NoSessionReplay stops a recorder carried in by a client-side
// navigation.
const REPLAY_FREE = /^\/(?:cut\/)?(?:app|s)(?:\/|$)/;

// The super-user host is off for a second reason: every one of its surfaces
// draws other people's email addresses, credit balances, and outreach state,
// and a replay would carry all of it to a third party. Its addresses are bare
// ("/analytics"), so the host is what identifies it.
const replayFree = () =>
  isSuHost(window.location.host) || REPLAY_FREE.test(window.location.pathname);

// Signed media URLs carry user-id paths and signatures; error messages that
// embed one get it masked before the event leaves the browser.
const scrubUrls = (s: string) => s.replace(/https?:\/\/\S+/g, "<url>");

/**
 * Whether this exception was thrown by script the page never served.
 *
 * An in-app browser — the web view inside a social or messaging app — injects
 * its own bridge into every page it opens, and that bridge throws when its
 * host tears the native side down mid-page ("Java object is gone"). The frames
 * come from no file, because there is no file: the code was evaluated into the
 * document. Anything this page shipped, minified or not, has a filename on
 * every frame, and an exception carrying no stack at all (a DOMException, say)
 * is ours to keep — so the test is a stack that exists and names nothing.
 */
const fromInjectedScript = (item: { stacktrace?: { frames?: { filename?: string }[] } }) => {
  const frames = item?.stacktrace?.frames;
  return Array.isArray(frames) && frames.length > 0 && frames.every((f) => !f?.filename);
};

/**
 * Whether this exception is a media read that never reached the file.
 *
 * A media source reads ahead of what anyone asked for, and mediabunny rethrows
 * a failed readahead so it isn't swallowed — with nothing awaiting those bytes
 * it reaches the page as an unhandled rejection with no failure behind it: the
 * next read of that range fetches it again, and reads someone is waiting on
 * reject into callers that retry. The read layer (cut/lib/mediaRead.ts) names
 * these, including the ones it refuses outright because the Donkey app is
 * closed, which the connect gate is already saying on screen.
 */
const recoveredMediaRead = (item: { type?: string }) => item?.type === "MediaFetchError";

// Production builds only: a dev server on localhost sends HMR build overlays
// and half-saved-file errors straight into production error tracking.
if (process.env.NEXT_PUBLIC_POSTHOG_KEY && process.env.NODE_ENV === "production") {
  posthog.init(process.env.NEXT_PUBLIC_POSTHOG_KEY, {
    api_host: "https://us.i.posthog.com",
    defaults: "2026-05-30",
    disable_session_recording: replayFree(),
    // Error tracking: unhandled errors, unhandled rejections, and every
    // console.error become $exception events. Failures a feature carries on
    // past reach it through cut/lib/report.ts, which words the report and
    // holds back the transient shapes — console.warn is not captured. Event
    // capture is memory-queued batches — none of session replay's canvas
    // readback cost, so it runs on the Cut surfaces too.
    capture_exceptions: {
      capture_unhandled_errors: true,
      capture_unhandled_rejections: true,
      capture_console_errors: true,
    },
    before_send: (event) => {
      if (event?.event === "$exception") {
        const list = event.properties?.$exception_list;
        if (Array.isArray(list)) {
          // Only as the exception itself: a report worded around one (its
          // cause, further down the list) is a failure that outlived retries.
          if (list.some(fromInjectedScript) || recoveredMediaRead(list[0])) return null;
          for (const item of list) {
            if (typeof item?.value === "string") item.value = scrubUrls(item.value);
          }
        }
      }
      return event;
    },
  });
}
