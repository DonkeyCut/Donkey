import posthog from "posthog-js";

// Surfaces that composite video onto a canvas every frame never record session
// replay (see app/_components/NoSessionReplay.tsx): the Cut app and the shared
// player, at their public paths and at the /cut/… routes the proxy serves them
// from. Disabling at init keeps the recorder script from loading at all on a
// direct load; NoSessionReplay stops a recorder carried in by a client-side
// navigation.
const REPLAY_FREE = /^\/(?:cut\/)?(?:app|s)(?:\/|$)/;

if (process.env.NEXT_PUBLIC_POSTHOG_KEY) {
  posthog.init(process.env.NEXT_PUBLIC_POSTHOG_KEY, {
    api_host: "https://us.i.posthog.com",
    defaults: "2026-05-30",
    disable_session_recording: REPLAY_FREE.test(window.location.pathname),
  });
}
