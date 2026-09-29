"use client";

import { useCallback, useEffect, useState } from "react";
import { Film } from "lucide-react";
import { Skeleton } from "@/components/ui/skeleton";
import { importPoster } from "@/cut/lib/importPoster";
import { holdMemory } from "@/cut/lib/memoryBudget";

type Props = { file: File; size: number };

/** A local frame while the original file is being imported to any shelf. */
export function ImportVideoPoster({ file, size }: Props) {
  const [visible, setVisible] = useState(false);
  const [poster, setPoster] = useState<string>();
  const [unreadable, setUnreadable] = useState(false);
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
    void importPoster(file, size, abort.signal).then((blob) => {
      if (abort.signal.aborted) return;
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
