"use client";

import { useRef } from "react";

import { Button } from "@/components/ui/button";
import type { BlogImageKind } from "@/lib/blog/images";
import { useRemoveBlogImage, useUploadBlogImage } from "@/queries/blog";

export const BLOG_IMAGE_ACCEPT = "image/png,image/jpeg,image/webp,image/gif,image/avif";

// Upload, replace and remove for the header or the thumbnail. The bytes go
// straight to storage and come back encoded; the row is updated by the route,
// so the preview the caller draws follows the query.
export function ImageUpload({
  postId,
  kind,
  hasImage,
  onUploaded,
}: {
  postId: string;
  kind: Exclude<BlogImageKind, "inline">;
  hasImage: boolean;
  onUploaded?: () => void;
}) {
  const upload = useUploadBlogImage(postId);
  const remove = useRemoveBlogImage(postId);
  const input = useRef<HTMLInputElement>(null);
  const busy = upload.isPending || remove.isPending;

  return (
    <div className="flex flex-wrap items-center gap-2">
      <input
        ref={input}
        type="file"
        accept={BLOG_IMAGE_ACCEPT}
        className="hidden"
        onChange={(event) => {
          const file = event.target.files?.[0];
          event.target.value = "";
          if (file) upload.mutate({ file, kind }, { onSuccess: () => onUploaded?.() });
        }}
      />
      <Button type="button" size="sm" variant="outline" disabled={busy} onClick={() => input.current?.click()}>
        {upload.isPending ? "Uploading…" : hasImage ? "Replace" : "Upload"}
      </Button>
      {hasImage ? (
        <Button type="button" size="sm" variant="ghost" disabled={busy} onClick={() => remove.mutate(kind)}>
          {remove.isPending ? "Removing…" : "Remove"}
        </Button>
      ) : null}
      {upload.isError ? <span className="text-xs text-destructive">{upload.error.message}</span> : null}
      {remove.isError ? <span className="text-xs text-destructive">{remove.error.message}</span> : null}
    </div>
  );
}
