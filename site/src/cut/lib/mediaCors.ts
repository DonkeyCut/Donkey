// Cut media is loaded with CORS everywhere, by every consumer, without
// exception — this constant is that rule, and it exists to be impossible to
// forget.
//
// The preview engine, the filmstrips and the AI frame grabs all read pixels
// back off a canvas, so their decoders load `crossOrigin="anonymous"`. A plain
// <video>/<img> pointed at the same file sends no Origin, and R2 answers an
// origin-less request with no CORS headers and — the part that bites — no
// `Vary: Origin`. The browser caches that response as the one answer for the
// URL, so a decoder that asks for it afterwards is handed a body it must
// reject on the CORS check: MEDIA_ERR_SRC_NOT_SUPPORTED, a clip that plays
// black for the life of the tab, and no amount of retrying or re-minting
// clears it. Whichever kind of load reaches a file first wins its cache entry,
// which is why it used to strike some clips in a project and not others.
//
// Loading one way everywhere removes the race: every response carries
// `Vary: Origin` and is cached against the origin that asked for it.
//
// Cut-hosted media only — engine files, project media, library files, exports.
// Stock and other remote media is somebody else's CORS policy, so it keeps
// loading plainly; nothing reads its pixels back.
export const MEDIA_CORS = "anonymous";
