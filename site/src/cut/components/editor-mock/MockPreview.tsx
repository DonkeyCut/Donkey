"use client";

import { useEffect, useRef } from "react";

import type { MockProject } from "@/cut/components/editor-mock/mockData";

// Static replica of the editor's preview stage (src/cut/components/Preview.tsx):
// the black rounded canvas on the muted backdrop, here playing a looping muted
// clip. Only the active slide's video runs so the two slides don't decode
// concurrently forever.
export function MockPreview({ project, active }: { project: MockProject; active: boolean }) {
  const videoRef = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    if (active) {
      // Autoplay can reject before any user gesture; the poster covers that.
      void video.play().catch(() => {});
    } else {
      video.pause();
    }
  }, [active]);

  const stage =
    project.aspect === "9:16"
      ? { width: 250, height: 444 }
      : { width: 480, height: 270 };

  return (
    <div className="flex min-w-0 items-center justify-center bg-muted/40 px-6">
      <div
        className="relative overflow-hidden rounded-xl bg-black shadow-[0_0_0_1px_rgba(0,0,0,0.08),0_12px_36px_rgba(0,0,0,0.18)]"
        style={stage}
      >
        <video
          ref={videoRef}
          className="h-full w-full object-cover"
          src={project.videoSrc}
          poster={project.videoPoster}
          muted
          loop
          playsInline
          preload="metadata"
        />
        {project.previewCaption ? (
          <div className="absolute inset-x-0 bottom-5 flex justify-center">
            <span className="px-3 text-center text-[17px] leading-tight font-bold text-white [text-shadow:0_1px_3px_rgba(0,0,0,0.85)]">
              {project.previewCaption}
            </span>
          </div>
        ) : null}
      </div>
    </div>
  );
}
