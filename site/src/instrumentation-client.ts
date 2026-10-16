import posthog from "posthog-js";

import { fetchDropped } from "./cut/lib/network";
import { bindFailureSink } from "./cut/lib/report";
import { reloadOnChunkError } from "./lib/chunkReload";

// Surfaces that composite video onto a canvas every frame never record session
// replay (see app/_components/NoSessionReplay.tsx): the Cut app and the shared
// player, at their public paths and at the /cut/… routes the proxy serves them
// from. Disabling at init keeps the recorder script from loading at all on a
// direct load; NoSessionReplay stops a recorder carried in by a client-side
// navigation.
const REPLAY_FREE = /^\/(?:cut\/)?(?:app|s)(?:\/|$)/;

const replayFree = () => REPLAY_FREE.test(window.location.pathname);

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

// The message a browser substitutes for an error thrown by a script from
// another origin loaded without CORS.
const OPAQUE_SCRIPT_ERROR = "Script error.";

/**
 * Whether this exception is an error the browser hid from the page.
 *
 * Every script this page ships is same-origin, and posthog-js loads its own
 * with crossorigin set, so their errors arrive with a message and a stack. A
 * script with neither — "Script error.", no frames — comes from somewhere
 * else, in practice a Safari extension's click listener, which fires one on
 * every click of a session and names nothing we could fix.
 */
const opaqueScriptError = (item: { value?: string; stacktrace?: { frames?: unknown[] } }) =>
  item?.value === OPAQUE_SCRIPT_ERROR && !item.stacktrace?.frames?.length;

// Notices a browser raises when a ResizeObserver callback resizes what it
// observes; the observers get the change on the next frame.
const RESIZE_OBSERVER_NOTICES = new Set([
  "ResizeObserver loop completed with undelivered notifications.",
  "ResizeObserver loop limit exceeded",
]);

/** Whether this exception is the browser's ResizeObserver loop notice. */
const browserNoise = (item: { value?: string }) =>
  typeof item?.value === "string" && RESIZE_OBSERVER_NOTICES.has(item.value);

// A frame in a script file: what this site ships is all .js files, from its
// own chunks or posthog-js's asset host.
const SCRIPT_FILE = /\.js(\?|#|$)/;

/**
 * Whether this exception was thrown by code evaluated into the page itself.
 *
 * Every script this page runs is a file, and the only inline scripts it
 * serves are data. A stack whose located frames all name the document ("/",
 * or the page's address) comes from code a browser feature or an extension
 * put there: Chrome's translator on iOS, a crypto wallet's provider. Native
 * frames ("[native code]", "<anonymous>") locate nothing either way.
 */
const fromDocumentScript = (item: { stacktrace?: { frames?: { filename?: string }[] } }) => {
  const located = (item?.stacktrace?.frames ?? []).filter((f) => /^(\/|https?:)/.test(f?.filename ?? ""));
  return located.length > 0 && located.every((f) => !SCRIPT_FILE.test(f.filename!));
};

// The language every page is served in, and the classes Chrome's and Edge's
// translators put on <html> once they rewrite a page.
const SERVED_LANG = "en";
const TRANSLATED_CLASSES = ["translated-ltr", "translated-rtl"];

// React's hydration mismatch errors (#418, #423, #425) and the DOM error a
// commit throws when a node it moves is no longer where React left it.
const RECONCILE_ERROR = /Minified React error #(418|423|425)\b|NotFoundError: Failed to execute '(insertBefore|removeChild)'/;

/**
 * Whether this exception is the browser's translator rewriting text React
 * owns on a page that leaves translation on (the marketing pages). React
 * recovers by rendering the page again, and the translator translates it
 * again; the error names nothing in our render.
 */
const translatorArtifact = (item: { value?: string }) => {
  const html = typeof document === "undefined" ? null : document.documentElement;
  const translated =
    !!html && (html.lang !== SERVED_LANG || TRANSLATED_CLASSES.some((c) => html.classList.contains(c)));
  return translated && typeof item?.value === "string" && RECONCILE_ERROR.test(item.value);
};

/**
 * Whether this exception is a fetch the network dropped, reported bare: the
 * router logging its own failed page fetch before it navigates the browser
 * there instead, or a library logging a read it retries. A failure that
 * outlived its retries reaches here worded by report.ts, with the dropped
 * fetch only as its cause.
 */
const droppedFetch = (item: { type?: string; value?: string }) =>
  item?.type === "TypeError" && typeof item.value === "string" && fetchDropped(new TypeError(item.value));

// A tab left open across a deploy recovers from the old build's missing chunks.
if (process.env.NODE_ENV === "production") {
  reloadOnChunkError(window);
}

// Production builds only: a dev server on localhost sends HMR build overlays
// and half-saved-file errors straight into production error tracking.
if (process.env.NEXT_PUBLIC_POSTHOG_KEY && process.env.NODE_ENV === "production") {
  posthog.init(process.env.NEXT_PUBLIC_POSTHOG_KEY, {
    api_host: "https://e.donkeycut.com",
    ui_host: "https://us.posthog.com",
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
          if (
            list.some(fromInjectedScript) ||
            list.some(fromDocumentScript) ||
            recoveredMediaRead(list[0]) ||
            opaqueScriptError(list[0]) ||
            browserNoise(list[0]) ||
            translatorArtifact(list[0]) ||
            droppedFetch(list[0])
          ) {
            return null;
          }
          for (const item of list) {
            if (typeof item?.value === "string") item.value = scrubUrls(item.value);
          }
        }
      }
      return event;
    },
  });

  // Failures Cut carried on past go straight to error tracking under the key
  // report.ts groups them by, and to the console for whoever has it open.
  bindFailureSink((error, fingerprint) => {
    console.warn(error);
    posthog.captureException(error, { $exception_fingerprint: fingerprint });
  });
}
