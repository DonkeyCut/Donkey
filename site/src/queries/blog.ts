"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import type { BlogPostAdmin, BlogPostAdminWithBody } from "@/lib/blog/admin";
import type { BlogImageKind } from "@/lib/blog/images";
import type { BlogPostInput } from "@/lib/blog/schema";
import { apiFetch } from "@/queries/apiClient";

export type { BlogPostAdmin, BlogPostAdminWithBody };

export const blogPostsQueryKey = ["su", "blog", "posts"] as const;
export const blogPostQueryKey = (id: string) => ["su", "blog", "post", id] as const;

export type BlogImageResult = { key: string; url: string; width: number; height: number };

const base = "/api/su/blog/posts";
const postUrl = (id: string, tail = "") => `${base}/${encodeURIComponent(id)}${tail}`;

// A write answers with the saved post; it lands in that post's cache and the
// list refetches.
function useTakePost() {
  const queryClient = useQueryClient();
  return (post: BlogPostAdmin | BlogPostAdminWithBody) => {
    queryClient.setQueryData<{ post: BlogPostAdminWithBody }>(blogPostQueryKey(post.id), (current) =>
      current ? { post: { ...current.post, ...post } } : "body" in post ? { post } : current,
    );
    void queryClient.invalidateQueries({ queryKey: blogPostsQueryKey });
  };
}

export function useBlogPosts() {
  return useQuery({
    queryFn: () => apiFetch<{ posts: BlogPostAdmin[] }>(base),
    queryKey: blogPostsQueryKey,
  });
}

export function useBlogPost(id: string) {
  return useQuery({
    queryFn: () => apiFetch<{ post: BlogPostAdminWithBody }>(postUrl(id)),
    queryKey: blogPostQueryKey(id),
  });
}

export function useCreateBlogPost() {
  const takePost = useTakePost();
  return useMutation({
    mutationFn: () => apiFetch<{ post: BlogPostAdmin }>(base, { method: "POST" }),
    onSuccess: ({ post }) => takePost(post),
  });
}

export function useSaveBlogPost(id: string) {
  const takePost = useTakePost();
  return useMutation({
    mutationFn: (input: BlogPostInput) =>
      apiFetch<{ post: BlogPostAdminWithBody }>(postUrl(id), { body: JSON.stringify(input), method: "PUT" }),
    onSuccess: ({ post }) => takePost(post),
  });
}

export function usePublishBlogPost(id: string) {
  const takePost = useTakePost();
  return useMutation({
    mutationFn: () => apiFetch<{ post: BlogPostAdminWithBody }>(postUrl(id, "/publish"), { method: "POST" }),
    onSuccess: ({ post }) => takePost(post),
  });
}

export function useUnpublishBlogPost(id: string) {
  const takePost = useTakePost();
  return useMutation({
    mutationFn: () => apiFetch<{ post: BlogPostAdminWithBody }>(postUrl(id, "/unpublish"), { method: "POST" }),
    onSuccess: ({ post }) => takePost(post),
  });
}

export type BlogGeneratedDetails = Pick<
  BlogPostInput,
  "seoTitle" | "excerpt" | "summary" | "tags" | "keywords" | "headerAlt"
>;

// Details written off the article. The pictures land on the row at once; the
// copy is the caller's to put in the form.
export function useGenerateBlogDetails(id: string) {
  const takePost = useTakePost();
  return useMutation({
    mutationFn: (input: { title: string; body: string }) =>
      apiFetch<{ post: BlogPostAdmin; details: BlogGeneratedDetails }>(postUrl(id, "/generate"), {
        body: JSON.stringify(input),
        method: "POST",
      }),
    onSuccess: ({ post }) => takePost(post),
  });
}

export function useDeleteBlogPost() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => apiFetch<{ ok: true }>(postUrl(id), { method: "DELETE" }),
    onSuccess: (_result, id) => {
      queryClient.removeQueries({ queryKey: blogPostQueryKey(id) });
      void queryClient.invalidateQueries({ queryKey: blogPostsQueryKey });
    },
  });
}

// The whole upload: a presigned scratch key, the bytes PUT straight to
// storage, then the encode that turns them into the image the pages serve.
export async function uploadBlogImage(id: string, file: File, kind: BlogImageKind) {
  const { key, putUrl } = await apiFetch<{ key: string; putUrl: string }>(postUrl(id, "/uploads"), {
    body: JSON.stringify({ mime: file.type, bytes: file.size }),
    method: "POST",
  });
  const put = await fetch(putUrl, { method: "PUT", body: file, headers: { "Content-Type": file.type } });
  if (!put.ok) throw new Error(`The upload was refused (${put.status}).`);
  return apiFetch<{ image: BlogImageResult; post?: BlogPostAdmin }>(postUrl(id, "/images"), {
    body: JSON.stringify({ uploadKey: key, kind }),
    method: "POST",
  });
}

export function useUploadBlogImage(id: string) {
  const takePost = useTakePost();
  return useMutation({
    mutationFn: ({ file, kind }: { file: File; kind: BlogImageKind }) => uploadBlogImage(id, file, kind),
    onSuccess: ({ post }) => {
      if (post) takePost(post);
    },
  });
}

export function useRemoveBlogImage(id: string) {
  const takePost = useTakePost();
  return useMutation({
    mutationFn: (kind: "header" | "thumbnail") =>
      apiFetch<{ post: BlogPostAdmin }>(postUrl(id, "/images/remove"), { body: JSON.stringify({ kind }), method: "POST" }),
    onSuccess: ({ post }) => takePost(post),
  });
}
