"use client";

import { useCallback, useEffect, useEffectEvent, useState } from "react";
import { Film } from "lucide-react";
import { Skeleton } from "@/components/ui/skeleton";
import { importPoster, type ImportPosterFrame } from "@/cut/lib/importPoster";
import { holdMemory } from "@/cut/lib/memoryBudget";

type Props = {
  file: File;
  size: number;
  onShape?: (shape: { width: number; height: number }) => void;
  /** The decoded frame while the tile holds it, and undefined once it lets go. */
  onFrame?: (frame: ImportPosterFrame | undefined) => void;
};

/** A local frame while the original file is being imported to any shelf. */
export function ImportVideoPoster({ file, size, onShape, onFrame }: Props) {
  const [visible, setVisible] = useState(false);
  const [poster, setPoster] = useState<string>();
  const [unreadable, setUnreadable] = useState(false);
  const measured = useEffectEvent((shape: { width: number; height: number }) => onShape?.(shape));
  const framed = useEffectEvent((frame: ImportPosterFrame | undefined) => onFrame?.(frame));
  const ref = useCallback((node: HTMLDivElement | null) => {
    if (!node) return;
    const observer = new IntersectionObserver(([entry]) => setVisible(entry.isIntersecting));
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (!visible) return;
    const abort = new AbortController();
    let url: string | undefined;
    let release: (() => void) | undefined;
    void importPoster(file, size, abort.signal).then((frame) => {
      if (abort.signal.aborted) return;
      const { blob, width, height } = frame;
      if (width && height) measured({ width, height });
      framed(frame);
      url = URL.createObjectURL(blob);
      release = holdMemory("libraryPictures", () => blob.size + size * size * 4);
      setPoster(url);
    }).catch(() => {
      // A missing local decoder leaves the import running on its chosen shelf.
      if (!abort.signal.aborted) setUnreadable(true);
    });
    return () => {
      abort.abort();
      if (url) URL.revokeObjectURL(url);
      release?.();
      setPoster(undefined);
      framed(undefined);
    };
  }, [file, size, visible]);

  return (
    <div ref={ref} className="size-full">
      {poster ? (
        // eslint-disable-next-line @next/next/no-img-element -- local decoded frame
        <img src={poster} alt={file.name} className="size-full object-cover" />
      ) : unreadable ? (
        <div className="flex size-full items-center justify-center bg-muted text-muted-foreground">
          <Film className="size-8" aria-label="Video" />
        </div>
      ) : <Skeleton className="size-full rounded-none" />}
    </div>
  );
}
