# Dependency patches

Applied by `patch-package` in `postinstall`. Each patch names the exact
version it was made against; `scripts/check-mediabunny-patch.mjs` stops the
install when the installed version drifts from the patch, so a bump always
comes with a look at whether the patch is still needed.

## mediabunny: decoded frames in flight

mediabunny's decode pump throttles on WebCodecs' `decodeQueueSize`, which
drains as soon as a packet reaches the platform decoder, and it starts every
stream with a 40-packet head start. Frames the decoder is still holding count
as nothing, so a stream whose reader pauses — the Cut preview with its ring
full — ends up with about 40 decoded full-size frames waiting in mediabunny's
sample queue. At 4K that is around a gigabyte per stream, held in the decoder
process (VTDecoderXPCService on a Mac, the GPU process elsewhere).

The patch gives `VideoDecoderWrapper` an `inFlight` count (packets submitted
minus frames output, reset on flush), reports it as the decoder's queue size,
and lowers the head start to 16. The same six edits land in the ES module and
both bundles.

Delete this patch when upstream's pump counts frames in flight itself: check
`computeMaxQueueSize` and the pump loops around `getDecodeQueueSize()` in
`dist/modules/src/media-sink.js` of the new version. Removing it means
deleting the patch file, this section, the check script, and `patch-package`
from `postinstall` and `devDependencies`, then running the perf eval's
playback bucket (`npm run eval:cut-perf -- --bucket playback`).
