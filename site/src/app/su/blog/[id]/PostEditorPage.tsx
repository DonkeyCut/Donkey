"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { BlogEditor } from "@/app/su/blog/[id]/BlogEditor";
import { DateTimeField } from "@/app/su/blog/[id]/DateTimeField";
import { HeaderFocusPicker } from "@/app/su/blog/[id]/HeaderFocusPicker";
import { ImageUpload } from "@/app/su/blog/[id]/ImageUpload";
import { TagInput } from "@/app/su/blog/[id]/TagInput";
import { Field } from "@/app/su/Field";
import { SuStandIn } from "@/app/su/SuStandIn";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { SU_APP_ORIGIN } from "@/cut/lib/hosts";
import {
  BLOG_DESCRIPTION_MAX,
  BLOG_DESCRIPTION_MIN,
  BLOG_SEO_TITLE_MAX,
  BLOG_TITLE_MAX,
  publishIssues,
  slugFromTitle,
  type BlogPostInput,
} from "@/lib/blog/schema";
import { ApiError } from "@/queries/apiClient";
import {
  uploadBlogImage,
  useBlogPost,
  useBlogPosts,
  usePublishBlogPost,
  useSaveBlogPost,
  useUnpublishBlogPost,
  type BlogPostAdminWithBody,
} from "@/queries/blog";

// One post in two tabs: the writing (title and article) and the details the
// page and the search result are built from. Save writes the whole draft;
// Publish saves first, then puts the post on the site.

export function PostEditorPage({ id }: { id: string }) {
  const post = useBlogPost(id);
  if (!post.data) {
    if (post.isPending) return <SuStandIn />;
    return (
      <div role="alert" className="space-y-3 rounded-lg border border-destructive/30 p-4">
        <p className="text-sm text-destructive">Couldn’t load the post. {post.error?.message}</p>
        <Button variant="outline" nativeButton={false} render={<Link href="/blog" />}>
          Back to posts
        </Button>
      </div>
    );
  }
  return <PostEditor key={post.data.post.id} post={post.data.post} />;
}

const inputOf = (post: BlogPostAdminWithBody): BlogPostInput => ({
  slug: post.slug,
  title: post.title,
  excerpt: post.excerpt,
  summary: post.summary,
  tags: post.tags,
  keywords: post.keywords,
  featured: post.featured,
  publishedAt: post.publishedAt,
  revisedAt: post.revisedAt,
  headerAlt: post.headerAlt,
  headerFocus: post.headerFocus,
  seoTitle: post.seoTitle,
  canonicalUrl: post.canonicalUrl,
  noIndex: post.noIndex,
  body: post.body,
});

const issuesByPath = (error: unknown): Record<string, string> => {
  const map: Record<string, string> = {};
  if (error instanceof ApiError) {
    for (const issue of error.issues) map[issue.path.split(".")[0] || "form"] = issue.message;
  }
  return map;
};

function Count({ value, max, min = 0 }: { value: string; max: number; min?: number }) {
  const n = value.trim().length;
  const off = n > max || (min > 0 && n > 0 && n < min);
  return (
    <span className={`text-xs tabular-nums ${off ? "text-destructive" : "text-muted-foreground"}`}>
      {n}/{max}
    </span>
  );
}

function CountedLabel({ htmlFor, children, value, max, min }: { htmlFor: string; children: string; value: string; max: number; min?: number }) {
  return (
    <div className="flex items-baseline justify-between">
      <Label htmlFor={htmlFor} className="text-xs text-muted-foreground">
        {children}
      </Label>
      <Count value={value} max={max} min={min} />
    </div>
  );
}

function PostEditor({ post }: { post: BlogPostAdminWithBody }) {
  const posts = useBlogPosts();
  const save = useSaveBlogPost(post.id);
  const publish = usePublishBlogPost(post.id);
  const unpublish = useUnpublishBlogPost(post.id);

  const [draft, setDraft] = useState<BlogPostInput>(() => inputOf(post));
  const [saved, setSaved] = useState<BlogPostInput>(() => inputOf(post));
  // The slug follows the title until it is edited by hand, or the post is
  // live and its address is spoken for.
  const [slugTouched, setSlugTouched] = useState(
    () => post.status === "PUBLISHED" || (post.title.trim().length > 0 && post.slug !== slugFromTitle(post.title)),
  );
  const [issues, setIssues] = useState<Record<string, string>>({});
  const [notice, setNotice] = useState<string | null>(null);
  // The keyboard shortcut and the title handler read the draft at the moment
  // they fire, outside a render.
  const draftRef = useRef(draft);
  useEffect(() => {
    draftRef.current = draft;
  }, [draft]);

  const dirty = useMemo(() => JSON.stringify(draft) !== JSON.stringify(saved), [draft, saved]);
  const busy = save.isPending || publish.isPending || unpublish.isPending;
  const published = post.status === "PUBLISHED";

  const patch = (next: Partial<BlogPostInput>) => setDraft((current) => ({ ...current, ...next }));

  const fail = (error: Error) => {
    setIssues(issuesByPath(error));
    setNotice(error.message);
  };

  // Writes the draft; resolves true when it landed.
  const doSave = useCallback(async () => {
    const submitted = draftRef.current;
    setIssues({});
    setNotice(null);
    try {
      const { post: row } = await save.mutateAsync(submitted);
      const next = inputOf(row);
      setSaved(next);
      // Keep what was typed during the save; otherwise take the row's
      // normalized values so the form shows exactly what is stored.
      setDraft((current) => (current === submitted ? next : current));
      return true;
    } catch (error) {
      fail(error as Error);
      return false;
    }
  }, [save]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s") {
        event.preventDefault();
        if (!save.isPending) void doSave();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [doSave, save.isPending]);

  useEffect(() => {
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault();
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);

  const doPublish = async () => {
    if (dirty && !(await doSave())) return;
    setIssues({});
    setNotice(null);
    publish.mutate(undefined, {
      onSuccess: ({ post: row }) => {
        const next = inputOf(row);
        setSaved(next);
        setDraft((current) => ({ ...current, publishedAt: next.publishedAt }));
        setSlugTouched(true);
      },
      onError: fail,
    });
  };

  const doUnpublish = () => {
    setNotice(null);
    unpublish.mutate(undefined, { onError: (error) => setNotice(error.message) });
  };

  const openPreview = async () => {
    if (dirty && !(await doSave())) return;
    window.open(`${SU_APP_ORIGIN}/api/blog/preview?id=${encodeURIComponent(post.id)}`, "_blank", "noopener");
  };

  const uploadInline = useCallback(
    async (file: File) => (await uploadBlogImage(post.id, file, "inline")).image.url,
    [post.id],
  );

  const suggestions = publishIssues({
    title: draft.title,
    excerpt: draft.excerpt,
    summary: draft.summary,
    headerKey: post.headerKey,
    thumbnailKey: post.thumbnailKey,
    publishedAt: draft.publishedAt,
    body: draft.body,
  });
  const allTags = useMemo(
    () => Array.from(new Set((posts.data?.posts ?? []).flatMap((row) => row.tags))).sort(),
    [posts.data],
  );
  const allKeywords = useMemo(
    () => Array.from(new Set((posts.data?.posts ?? []).flatMap((row) => row.keywords))).sort(),
    [posts.data],
  );
  const error = (path: string) =>
    issues[path] ? (
      <p role="alert" className="text-xs text-destructive">
        {issues[path]}
      </p>
    ) : null;

  return (
    <Tabs defaultValue="write" className="gap-6 pb-9">
      <div className="flex flex-wrap items-center gap-2">
        <Button variant="ghost" size="sm" nativeButton={false} render={<Link href="/blog" />}>
          ← Posts
        </Button>
        <Badge variant={published ? "default" : "outline"}>{published ? "Published" : "Draft"}</Badge>
        <TabsList variant="line">
          <TabsTrigger value="write">Write</TabsTrigger>
          <TabsTrigger value="details">Details</TabsTrigger>
        </TabsList>
        {dirty ? <span className="text-xs text-muted-foreground">Unsaved changes</span> : null}
        {notice ? (
          <span role="alert" className="text-xs text-destructive">
            {notice}
          </span>
        ) : null}
        <div className="ml-auto flex flex-wrap items-center gap-2">
          <Button size="sm" variant="outline" disabled={busy} onClick={() => void openPreview()}>
            Preview
          </Button>
          {published ? (
            <Button
              size="sm"
              variant="outline"
              nativeButton={false}
              render={<a href={`${SU_APP_ORIGIN}/blog/${post.slug}`} target="_blank" rel="noreferrer" />}
            >
              View
            </Button>
          ) : null}
          <Button size="sm" variant={dirty ? "default" : "outline"} disabled={busy || !dirty} onClick={() => void doSave()}>
            {save.isPending ? "Saving…" : "Save"}
          </Button>
          {published ? (
            <Button size="sm" variant="outline" disabled={busy} onClick={doUnpublish}>
              {unpublish.isPending ? "Unpublishing…" : "Unpublish"}
            </Button>
          ) : (
            <Button size="sm" disabled={busy} onClick={() => void doPublish()}>
              {publish.isPending ? "Publishing…" : "Publish"}
            </Button>
          )}
        </div>
      </div>

      <TabsContent value="write" className="space-y-4">
        <div className="space-y-1.5">
          <CountedLabel htmlFor="title" value={draft.title} max={BLOG_TITLE_MAX}>
            Title
          </CountedLabel>
          <Input
            id="title"
            value={draft.title}
            placeholder="Post title"
            className="h-12 text-xl font-semibold md:text-xl"
            onChange={(e) => {
              const title = e.target.value;
              patch(slugTouched ? { title } : { title, slug: slugFromTitle(title) || draftRef.current.slug });
            }}
          />
          {error("title")}
        </div>
        <BlogEditor markdown={saved.body} diffMarkdown={saved.body} onChange={(body) => patch({ body })} uploadImage={uploadInline} />
        {error("body")}
      </TabsContent>

      <TabsContent value="details" className="space-y-8">
        <section className="space-y-4">
          <h2 className="text-sm font-semibold">Images</h2>
          <div className="space-y-2">
            <h3 className="text-xs font-medium text-muted-foreground">Header, 1080×240 on the page</h3>
            <ImageUpload postId={post.id} kind="header" url={post.headerUrl} label="Header image" className="h-60 w-full">
              {post.headerUrl ? (
                <HeaderFocusPicker
                  src={post.headerUrl}
                  alt={draft.headerAlt}
                  focus={draft.headerFocus}
                  onChange={(focus) => patch({ headerFocus: focus })}
                />
              ) : null}
            </ImageUpload>
            {post.headerUrl ? (
              <p className="text-xs text-muted-foreground">Click or drag on the image to set what stays in frame.</p>
            ) : null}
            {error("header")}
          </div>
          <div className="grid gap-6 md:grid-cols-2">
            <div className="space-y-2">
              <h3 className="text-xs font-medium text-muted-foreground">Thumbnail, 800×500 on the index</h3>
              <ImageUpload postId={post.id} kind="thumbnail" url={post.thumbnailUrl} label="Thumbnail" className="aspect-[8/5] w-full" />
              {error("thumbnail")}
            </div>
            {post.headerUrl ? (
              <Field label="Header alt text" htmlFor="headerAlt">
                <Input id="headerAlt" value={draft.headerAlt} onChange={(e) => patch({ headerAlt: e.target.value })} />
                {error("headerAlt")}
              </Field>
            ) : null}
          </div>
        </section>

        <div className="grid gap-8 md:grid-cols-2">
          <section className="space-y-4">
            <h2 className="text-sm font-semibold">Page</h2>
            <Field label="Address" htmlFor="slug">
              <div className="flex items-center gap-1">
                <span className="shrink-0 text-sm text-muted-foreground">donkeycut.com/blog/</span>
                <Input
                  id="slug"
                  value={draft.slug}
                  onChange={(e) => {
                    setSlugTouched(true);
                    patch({ slug: e.target.value.toLowerCase() });
                  }}
                />
              </div>
              {error("slug")}
            </Field>
            <div className="space-y-1.5">
              <CountedLabel htmlFor="summary" value={draft.summary} max={BLOG_DESCRIPTION_MAX} min={BLOG_DESCRIPTION_MIN}>
                Summary, the answer-first line under the title
              </CountedLabel>
              <Textarea id="summary" rows={3} value={draft.summary} onChange={(e) => patch({ summary: e.target.value })} />
              {error("summary")}
            </div>
            <Field label="Tags" htmlFor="tags">
              <TagInput
                id="tags"
                value={draft.tags}
                suggestions={allTags}
                normalize={(word) => word.trim().toLowerCase()}
                placeholder="Add a tag"
                onChange={(tags) => patch({ tags })}
              />
              {error("tags")}
            </Field>
            <div className="flex items-center justify-between gap-3">
              <Label htmlFor="featured" className="text-xs text-muted-foreground">
                Featured on the index
              </Label>
              <Switch id="featured" checked={draft.featured} onCheckedChange={(featured) => patch({ featured })} />
            </div>
            <Field label="Publish date" htmlFor="publishedAt">
              <DateTimeField id="publishedAt" value={draft.publishedAt} onChange={(publishedAt) => patch({ publishedAt })} />
              {error("publishedAt")}
            </Field>
            <Field label="Revised date" htmlFor="revisedAt">
              <DateTimeField id="revisedAt" value={draft.revisedAt} onChange={(revisedAt) => patch({ revisedAt })} />
              {error("revisedAt")}
            </Field>
          </section>

          <section className="space-y-4">
            <h2 className="text-sm font-semibold">Search</h2>
            <div className="space-y-1.5">
              <CountedLabel htmlFor="seoTitle" value={draft.seoTitle} max={BLOG_SEO_TITLE_MAX}>
                Meta title
              </CountedLabel>
              <Input
                id="seoTitle"
                value={draft.seoTitle}
                placeholder={draft.title ? `${draft.title} | Donkey Cut` : "Falls back to the title"}
                onChange={(e) => patch({ seoTitle: e.target.value })}
              />
              {error("seoTitle")}
            </div>
            <div className="space-y-1.5">
              <CountedLabel htmlFor="excerpt" value={draft.excerpt} max={BLOG_DESCRIPTION_MAX} min={BLOG_DESCRIPTION_MIN}>
                Meta description
              </CountedLabel>
              <Textarea id="excerpt" rows={3} value={draft.excerpt} onChange={(e) => patch({ excerpt: e.target.value })} />
              {error("excerpt")}
            </div>
            <Field label="Keywords" htmlFor="keywords">
              <TagInput
                id="keywords"
                value={draft.keywords}
                suggestions={allKeywords}
                placeholder="Add a keyword"
                onChange={(keywords) => patch({ keywords })}
              />
              {error("keywords")}
            </Field>
            <Field label="Canonical address" htmlFor="canonicalUrl">
              <Input
                id="canonicalUrl"
                type="url"
                value={draft.canonicalUrl}
                placeholder={`https://donkeycut.com/blog/${draft.slug}`}
                onChange={(e) => patch({ canonicalUrl: e.target.value })}
              />
              {error("canonicalUrl")}
            </Field>
            <div className="flex items-center justify-between gap-3">
              <Label htmlFor="noIndex" className="text-xs text-muted-foreground">
                Keep out of search results
              </Label>
              <Switch id="noIndex" checked={draft.noIndex} onCheckedChange={(noIndex) => patch({ noIndex })} />
            </div>
            {suggestions.length > 0 ? (
              <div className="space-y-1">
                <h3 className="text-xs font-medium text-muted-foreground">Suggested before publishing</h3>
                <ul className="space-y-1 text-xs text-muted-foreground">
                  {suggestions.map((issue) => (
                    <li key={issue.path}>· {issue.message}</li>
                  ))}
                </ul>
              </div>
            ) : null}
          </section>
        </div>
      </TabsContent>
    </Tabs>
  );
}
