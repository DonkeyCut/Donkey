import posthog from "posthog-js";

// Surfaces that composite video onto a canvas every frame never record session
// replay (see app/_components/NoSessionReplay.tsx): the Cut app and the shared
// player, at their public paths and at the /cut/… routes the proxy serves them
// from. Disabling at init keeps the recorder script from loading at all on a
// direct load; NoSessionReplay stops a recorder carried in by a client-side
// navigation.
const REPLAY_FREE = /^\/(?:cut\/)?(?:app|s)(?:\/|$)/;

// Signed media URLs carry user-id paths and signatures; error messages that
// embed one get it masked before the event leaves the browser.
const scrubUrls = (s: string) => s.replace(/https?:\/\/\S+/g, "<url>");

// Production builds only: a dev server on localhost sends HMR build overlays
// and half-saved-file errors straight into production error tracking.
if (process.env.NEXT_PUBLIC_POSTHOG_KEY && process.env.NODE_ENV === "production") {
  posthog.init(process.env.NEXT_PUBLIC_POSTHOG_KEY, {
    api_host: "https://us.i.posthog.com",
    defaults: "2026-05-30",
    disable_session_recording: REPLAY_FREE.test(window.location.pathname),
    // Error tracking: unhandled errors, unhandled rejections, and every
    // console.error become $exception events. Failures a feature swallows on
    // purpose reach it by logging with console.error. Event capture is
    // memory-queued batches — none of session replay's canvas readback cost,
    // so it runs on the Cut surfaces too.
    capture_exceptions: {
      capture_unhandled_errors: true,
      capture_unhandled_rejections: true,
      capture_console_errors: true,
    },
    before_send: (event) => {
      if (event?.event === "$exception") {
        const list = event.properties?.$exception_list;
        if (Array.isArray(list)) {
          for (const item of list) {
            if (typeof item?.value === "string") item.value = scrubUrls(item.value);
          }
        }
      }
      return event;
    },
  });
}
