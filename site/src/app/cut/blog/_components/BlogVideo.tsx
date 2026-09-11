import { parseVideoUrl } from "@/lib/blog/video";

// <Video src="…" /> in an article. A YouTube or Vimeo address becomes its
// player in a 16:9 frame, a direct file plays in a video element, and an
// address that is neither stays a link.
export function BlogVideo({ src, title }: { src: string; title?: string }) {
  const source = parseVideoUrl(src);
  if (!source) {
    return (
      <p>
        <a href={src}>{src}</a>
      </p>
    );
  }
  if (source.kind === "file") {
    return (
      <div className="not-prose my-6 overflow-hidden rounded-2xl border-2 border-ink bg-ink">
        <video src={source.src} controls preload="metadata" playsInline className="block aspect-video w-full" />
      </div>
    );
  }
  return (
    <div className="not-prose relative my-6 aspect-video w-full overflow-hidden rounded-2xl border-2 border-ink bg-ink">
      <iframe
        src={source.embedSrc}
        title={title ?? (source.kind === "youtube" ? "YouTube video" : "Vimeo video")}
        loading="lazy"
        allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share"
        allowFullScreen
        className="absolute inset-0 size-full border-0"
      />
    </div>
  );
}
