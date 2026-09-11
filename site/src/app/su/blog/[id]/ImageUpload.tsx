"use client";

import { ImagePlus, Trash2, Upload } from "lucide-react";
import { useRef, useState, type ReactNode } from "react";

import { Button } from "@/components/ui/button";
import type { BlogImageKind } from "@/lib/blog/images";
import { cn } from "@/lib/utils";
import { useRemoveBlogImage, useUploadBlogImage } from "@/queries/blog";

export const BLOG_IMAGE_ACCEPT = "image/png,image/jpeg,image/webp,image/gif,image/avif";

// The image box is the upload: empty, it takes a click or a dropped file;
// filled, it draws the image (or whatever the caller puts there, such as the
// focus picker) with replace and remove on hover. The bytes go straight to
// storage and come back encoded; the route updates the row, so the caller's
// image follows the query.
export function ImageUpload({
  postId,
  kind,
  url,
  label,
  className,
  children,
}: {
  postId: string;
  kind: Exclude<BlogImageKind, "inline">;
  url: string | null;
  label: string;
  className?: string;
  children?: ReactNode;
}) {
  const upload = useUploadBlogImage(postId);
  const remove = useRemoveBlogImage(postId);
  const input = useRef<HTMLInputElement>(null);
  const [over, setOver] = useState(false);
  const busy = upload.isPending || remove.isPending;

  const take = (file: File | undefined) => {
    if (file && file.type.startsWith("image/")) upload.mutate({ file, kind });
  };

  return (
    <div className="space-y-1.5">
      <div
        className={cn("group relative overflow-hidden rounded-2xl", className)}
        onDragOver={(event) => {
          event.preventDefault();
          setOver(true);
        }}
        onDragLeave={() => setOver(false)}
        onDrop={(event) => {
          event.preventDefault();
          setOver(false);
          take(event.dataTransfer.files[0]);
        }}
      >
        <input
          ref={input}
          type="file"
          accept={BLOG_IMAGE_ACCEPT}
          className="hidden"
          onChange={(event) => {
            take(event.target.files?.[0]);
            event.target.value = "";
          }}
        />
        {url ? (
          <>
            {children ?? <img src={url} alt="" className="size-full object-cover" />}
            <div className="absolute top-2 right-2 flex gap-1.5 opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
              <Button type="button" size="sm" variant="secondary" disabled={busy} onClick={() => input.current?.click()}>
                <Upload />
                Replace
              </Button>
              <Button type="button" size="sm" variant="secondary" disabled={busy} onClick={() => remove.mutate(kind)}>
                <Trash2 />
                Remove
              </Button>
            </div>
          </>
        ) : (
          <button
            type="button"
            disabled={busy}
            onClick={() => input.current?.click()}
            className={cn(
              "flex size-full flex-col items-center justify-center gap-2 rounded-2xl border-2 border-dashed text-sm text-muted-foreground transition-colors hover:border-foreground/40 hover:text-foreground",
              over && "border-foreground/60 bg-muted text-foreground",
            )}
          >
            <ImagePlus className="size-5" />
            <span>{label}</span>
            <span className="text-xs">Click or drop an image</span>
          </button>
        )}
        {busy ? (
          <div className="absolute inset-0 flex items-center justify-center bg-background/70 text-sm">
            {upload.isPending ? "Uploading…" : "Removing…"}
          </div>
        ) : over && url ? (
          <div className="pointer-events-none absolute inset-0 flex items-center justify-center bg-background/70 text-sm">
            Drop to replace
          </div>
        ) : null}
      </div>
      {upload.isError ? <p className="text-xs text-destructive">{upload.error.message}</p> : null}
      {remove.isError ? <p className="text-xs text-destructive">{remove.error.message}</p> : null}
    </div>
  );
}
