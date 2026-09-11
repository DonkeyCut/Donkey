// The article's hero: a fixed 240px band the image covers, positioned by the
// focus the CMS set so the subject stays in frame on every width.
export function BlogHeaderImage({ src, alt, focus }: { src: string; alt: string; focus: string | null }) {
  return (
    <div className="relative mb-6 h-60 w-full overflow-hidden rounded-2xl border-2 border-ink bg-cream md:mb-8">
      {/* eslint-disable-next-line @next/next/no-img-element -- pre-encoded AVIF from the media host, not Next-optimizable */}
      <img
        src={src}
        alt={alt}
        fetchPriority="high"
        className="absolute inset-0 h-full w-full object-cover select-none"
        style={{ objectPosition: focus ?? "50% 50%" }}
        draggable={false}
      />
    </div>
  );
}
