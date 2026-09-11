"use client";

import Link from "next/link";
import { useState } from "react";

import { SuStandIn } from "@/app/su/SuStandIn";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { useBlogPosts, useDeleteBlogPost, type BlogPostAdmin } from "@/queries/blog";

const when = (iso: string) =>
  new Date(iso).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });

// Every post in one list, the most recently touched first. A row opens the
// editor; delete sits behind a confirmation because it also sweeps the post's
// images out of storage.
export default function SuBlogPage() {
  const posts = useBlogPosts();

  const loadError = posts.isError ? (
    <div role="alert" className="space-y-3 rounded-lg border border-destructive/30 p-4">
      <p className="text-sm text-destructive">Couldn’t load posts. {posts.error.message}</p>
      <Button variant="outline" disabled={posts.isFetching} onClick={() => void posts.refetch()}>
        {posts.isFetching ? "Retrying…" : "Retry"}
      </Button>
    </div>
  ) : null;

  if (!posts.data) return posts.isPending ? <SuStandIn /> : loadError;
  const rows = posts.data.posts;

  return (
    <div className="space-y-3 pb-9">
      {loadError}
      {rows.length === 0 ? <p className="text-sm text-muted-foreground">No posts yet.</p> : null}
      {rows.map((post) => (
        <PostRow key={post.id} post={post} />
      ))}
    </div>
  );
}

function PostRow({ post }: { post: BlogPostAdmin }) {
  const remove = useDeleteBlogPost();
  const [confirmDelete, setConfirmDelete] = useState(false);
  const title = post.title.trim() || "Untitled post";
  return (
    <div className="flex items-start gap-4 rounded-lg border p-4">
      {post.thumbnailUrl ? (
        // eslint-disable-next-line @next/next/no-img-element -- pre-encoded AVIF from the media host, not Next-optimizable
        <img
          src={post.thumbnailUrl}
          alt=""
          className="hidden h-16 w-[102px] shrink-0 rounded-md border object-cover sm:block"
        />
      ) : (
        <div className="hidden h-16 w-[102px] shrink-0 rounded-md border bg-muted sm:block" />
      )}
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <Link href={`/blog/${post.id}`} className="font-medium hover:underline">
            {title}
          </Link>
          <Badge variant={post.status === "PUBLISHED" ? "default" : "outline"}>
            {post.status === "PUBLISHED" ? "Published" : "Draft"}
          </Badge>
          {post.featured ? <Badge variant="secondary">Featured</Badge> : null}
          {post.noIndex ? <Badge variant="outline">noindex</Badge> : null}
        </div>
        <p className="mt-1 truncate text-sm text-muted-foreground">/blog/{post.slug}</p>
        <p className="mt-1 text-xs text-muted-foreground">
          {post.publishedAt ? `Published ${when(post.publishedAt)} · ` : ""}
          Edited {when(post.updatedAt)}
          {post.tags.length > 0 ? ` · ${post.tags.join(", ")}` : ""}
        </p>
      </div>
      <div className="flex shrink-0 items-center gap-2">
        <Button size="sm" variant="outline" nativeButton={false} render={<Link href={`/blog/${post.id}`} />}>
          Edit
        </Button>
        <Button
          size="sm"
          variant="ghost"
          disabled={remove.isPending}
          onClick={() => {
            remove.reset();
            setConfirmDelete(true);
          }}
        >
          Delete
        </Button>
      </div>
      <AlertDialog
        open={confirmDelete}
        onOpenChange={(isOpen) => {
          if (!remove.isPending) setConfirmDelete(isOpen);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete “{title}”?</AlertDialogTitle>
            <AlertDialogDescription>
              {post.status === "PUBLISHED"
                ? "The page comes down and its images are removed from storage."
                : "The draft and its images are removed from storage."}
            </AlertDialogDescription>
          </AlertDialogHeader>
          {remove.isError ? (
            <p role="alert" className="text-sm text-destructive">
              Couldn’t delete the post. {remove.error.message}
            </p>
          ) : null}
          <AlertDialogFooter>
            <AlertDialogCancel disabled={remove.isPending}>Keep</AlertDialogCancel>
            <AlertDialogAction
              disabled={remove.isPending}
              onClick={() => remove.mutate(post.id, { onSuccess: () => setConfirmDelete(false) })}
            >
              {remove.isPending ? "Deleting…" : "Delete"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
