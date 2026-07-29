"use client";

import { useEffect, useRef, useState } from "react";

/** How many fatal errors playback may recover from before it is treated as
 * broken. A real network blip resolves in one or two; anything past this is a
 * permanent failure wearing a transient error's clothes. */
const MAX_RECOVERIES = 3;

/**
 * A `<video>` playing an HLS master playlist.
 *
 * Safari and iOS play HLS natively, so they get the URL directly and hls.js
 * never loads — attaching it there would replace a well-tuned platform player
 * with a worse one. Everywhere else (Chrome and Android have no native HLS)
 * hls.js is imported on demand, so its weight lands only on the browsers that
 * need it and never on the initial page.
 */
export function HlsVideo({
  src,
  poster,
  className,
  onError,
  onPlaying,
}: {
  src: string;
  poster?: string;
  className?: string;
  onError?: () => void;
  /** Fires once playback is actually running, so a caller can avoid replacing
   * a video someone is watching. */
  onPlaying?: () => void;
}) {
  const ref = useRef<HTMLVideoElement>(null);
  const [failed, setFailed] = useState(false);
  // Held in a ref so the effect below does not depend on it. A caller passing an
  // inline arrow — the normal way to write this — would otherwise hand over a
  // new function every render and tear down and rebuild the player each time.
  const onErrorRef = useRef(onError);
  useEffect(() => {
    onErrorRef.current = onError;
  }, [onError]);

  useEffect(() => {
    const video = ref.current;
    if (!video) return;
    setFailed(false);
    let live = true;

    const giveUp = () => {
      if (!live) return;
      live = false;
      setFailed(true);
      onErrorRef.current?.();
    };

    // Native HLS. Checked before loading the library so Safari/iOS take this
    // path — canPlayType answers for the platform player, not for hls.js.
    if (video.canPlayType("application/vnd.apple.mpegurl")) {
      // The platform player reports through the element, and this is the only
      // channel it has: without it an expired token 403s every segment, the
      // video stalls on a black frame, and nothing upstream ever learns that
      // playback died.
      video.addEventListener("error", giveUp);
      video.src = src;
      return () => {
        live = false;
        video.removeEventListener("error", giveUp);
      };
    }

    let destroy: (() => void) | undefined;
    void import("hls.js").then(({ default: Hls }) => {
      if (!live || !ref.current) return;
      if (!Hls.isSupported()) {
        // Neither native nor MSE: nothing left to try.
        giveUp();
        return;
      }
      const hls = new Hls({
        // The ladder's own rung choice is the point of streaming here; cap how
        // far ahead it buffers so a phone on cellular does not pull minutes of
        // a long cut it may never watch.
        maxBufferLength: 30,
        maxMaxBufferLength: 60,
      });
      // Recovery is bounded. Each kind of fatal error has a documented retry,
      // so a dropped segment reconnects instead of ending playback — but an
      // error that is permanent rather than transient (an expired token, a
      // ladder swept out from under the viewer) repeats forever, and retrying
      // it without a budget pins the phone in a request loop against the edge
      // and never reaches the failure the viewer needs to see.
      let recoveries = 0;
      hls.on(Hls.Events.ERROR, (_e, data) => {
        if (!data.fatal) return;
        const recoverable =
          data.type === Hls.ErrorTypes.NETWORK_ERROR || data.type === Hls.ErrorTypes.MEDIA_ERROR;
        if (!recoverable || recoveries >= MAX_RECOVERIES) {
          hls.destroy();
          giveUp();
          return;
        }
        recoveries++;
        if (data.type === Hls.ErrorTypes.NETWORK_ERROR) hls.startLoad();
        else hls.recoverMediaError();
      });
      hls.loadSource(src);
      hls.attachMedia(ref.current);
      destroy = () => hls.destroy();
    });

    return () => {
      live = false;
      destroy?.();
    };
  }, [src]);

  return (
    <video
      ref={ref}
      poster={poster}
      controls
      playsInline
      preload="metadata"
      className={className}
      onPlaying={onPlaying}
      aria-label={failed ? "Video unavailable" : undefined}
    />
  );
}
