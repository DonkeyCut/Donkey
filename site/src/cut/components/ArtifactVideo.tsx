"use client";

import { useEffect, useRef, useState, type RefObject, type VideoHTMLAttributes } from "react";

/** How many fatal errors playback may recover from before it is treated as
 * broken. A real network blip resolves in one or two; anything past this is a
 * permanent failure wearing a transient error's clothes. */
const MAX_RECOVERIES = 3;

export type ArtifactVideoProps = Omit<VideoHTMLAttributes<HTMLVideoElement>, "src" | "onError"> & {
  src: string;
  format: "hls" | "file";
  videoRef?: RefObject<HTMLVideoElement | null>;
  onError?: () => void;
  active?: boolean;
};

/** Playback owns its decoder, buffers and teardown independently of an editor. */
export function ArtifactVideo({
  src, format, videoRef, onError, active = true, controls = true, autoPlay = false, preload = "metadata", ...props
}: ArtifactVideoProps) {
  const ownRef = useRef<HTMLVideoElement>(null);
  const ref = videoRef ?? ownRef;
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
    if (!video || !active) return;
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
    if (format === "file" || video.canPlayType("application/vnd.apple.mpegurl")) {
      // The platform player reports through the element, and this is the only
      // channel it has: without it an expired token 403s every segment, the
      // video stalls on a black frame, and nothing upstream ever learns that
      // playback died.
      video.addEventListener("error", giveUp);
      video.src = src;
      return () => {
        live = false;
        video.removeEventListener("error", giveUp);
        video.pause();
        video.removeAttribute("src");
        video.load();
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
    }).catch(giveUp);

    return () => {
      live = false;
      destroy?.();
      video.pause();
      video.removeAttribute("src");
      video.load();
    };
  }, [src, format, ref, active]);

  useEffect(() => {
    const video = ref.current;
    if (!video) return;
    if (!active) video.pause();
    const hide = () => { if (document.hidden) video.pause(); };
    const observer = typeof IntersectionObserver === "undefined" ? null : new IntersectionObserver((entries) => {
      if (entries.some((entry) => !entry.isIntersecting)) video.pause();
    });
    observer?.observe(video);
    document.addEventListener("visibilitychange", hide);
    return () => {
      observer?.disconnect();
      document.removeEventListener("visibilitychange", hide);
    };
  }, [active, ref]);

  return (
    <video
      {...props}
      ref={ref}
      controls={controls}
      playsInline
      autoPlay={active && autoPlay}
      preload={preload}
      aria-label={failed ? "Video unavailable" : props["aria-label"]}
    />
  );
}
