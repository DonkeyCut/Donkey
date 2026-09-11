"use client";

import { useRouter } from "next/navigation";

import { Button } from "@/components/ui/button";
import { useCreateBlogPost } from "@/queries/blog";

// Makes a draft and opens it. The draft exists before a word is typed so the
// editor has a post id to upload images under.
export function NewPostButton() {
  const router = useRouter();
  const create = useCreateBlogPost();
  return (
    <div className="flex items-center gap-3">
      {create.isError ? <span className="text-sm text-destructive">Couldn’t create the post.</span> : null}
      <Button
        size="sm"
        disabled={create.isPending}
        onClick={() => create.mutate(undefined, { onSuccess: ({ post }) => router.push(`/blog/${post.id}`) })}
      >
        {create.isPending ? "Creating…" : "New post"}
      </Button>
    </div>
  );
}
