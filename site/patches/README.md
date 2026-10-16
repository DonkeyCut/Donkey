# Dependency patches

Applied by `patch-package` in `postinstall`. Each patch names the exact
version it was made against; `scripts/check-mediabunny-patch.mjs` stops the
install when the installed version drifts from the patch, so a bump always
comes with a look at whether the patch is still needed.

## mediabunny: decoded frames in flight

mediabunny's decode pump throttles on WebCodecs' `decodeQueueSize`, which
drains as soon as a packet reaches the platform decoder, with a 40-packet head
start. A stream whose reader pauses — the preview with its ring full — holds
about 40 decoded frames, around a gigabyte per stream at 4K.

The patch gives `VideoDecoderWrapper` an `inFlight` count (packets submitted
minus frames output, reset on flush), reports it as the decoder's queue size,
and lowers the head start to 16. A read that ends in an error wakes the parked
pump, so the failed decoder closes and frees its frames. The edits land in the
ES module and all three bundles.

Delete this patch when upstream's pump counts frames in flight itself: check
`computeMaxQueueSize` and the pump loops around `getDecodeQueueSize()` in
`dist/modules/src/media-sink.js` of the new version. Removing it means
deleting the patch file, this section, the check script, and `patch-package`
from `postinstall` and `devDependencies`, then running the perf eval's
playback bucket (`npm run eval:cut-perf -- --bucket playback`).

## @mediabunny/prores: the WASM binary as base64

The ProRes decoder embeds its WASM binary as an escaped template literal. The
production minifier rewrites `\x00` before a digit as `\0`, which inside a
template literal is an octal escape and a SyntaxError, so the decoder chunk
never loads and every ProRes import fails at the probe. The patch stores the
binary as a base64 string read through `atob`: the same bytes, with no escapes
to rewrite. Delete it when a production build's decoder chunk parses without it
(`node --check` on the emitted chunk).
