# The Blog

donkeycut.com/blog is the site's writing surface for search: an index of posts,
one page per post, and a sitemap that lists them. The words and images of a
post live outside the repository. A post's row is in Postgres, its article is
an MDX file in the private bucket, its images sit beside that file, and the
Blog tab on the super-user host is where all of it is written.

**The one rule:** the repository holds the layout and the machinery; the
content lives in the database and the bucket. A post reaches the site through
the CMS and the cache.

## How a post reaches the page

```text
su Blog tab: write, upload, save, publish
        │
        ▼
row in Postgres  ·  blog/<id>/article.mdx and blog/<id>/<sha>.avif in the bucket
        │  every write clears the `blog` tag and the post's own `blog:<slug>` tag
        ▼
/blog and /blog/<slug> read through `use cache` and compile the MDX inside it
        │
        ▼
the static shell serves; the article streams in from the cache
```

The public pages are ordinary Cache Components pages: the shell is static,
the reads are cached and tagged, and a save in the CMS expires the tags so the
next visitor gets the new page. Nothing renders per request. The MDX compile
happens inside the cache too, so a page costs one compile per publish.

## What a post is

A row carries what the index card and the search result need: the address, the
title, the meta description, an optional answer-first summary, tags, keywords,
the publish and revised dates, whether it is the featured post, and the header
and thumbnail images with the header's focus point. The search controls are
per post: a meta title that overrides the title, a canonical address that
overrides the page's own, and a switch that keeps the post out of results.

The article is markdown with three named blocks the page knows: a `Video` for
a YouTube, Vimeo or direct file address, and two calls to action. Images in the
article are plain markdown images pointing at the media host. A `## FAQs`
section with `###` questions becomes FAQ structured data on its own.

Publishing holds a post to a short contract: a title within the length a
result shows, a meta description in range, both images, a body, and no publish
date in the future. The editor shows the same checklist the route enforces.

## Images

Image bytes go straight to the bucket. The browser asks for a signed upload
address under the post, puts the bytes there, then names that key to the
encode route. The route reads it, encodes it to the size its role needs (the
header crop, the thumbnail crop, or a width-capped inline image) as AVIF,
writes it under its content hash, and deletes the upload. The media Worker
serves those hashed keys under `blog/` without a token and with an immutable
cache; the article source and the upload scratch keys stay private.

## Previewing a draft

Preview is Draft Mode. The editor's Preview button opens a route on the apex
host that turns Draft Mode on for that browser and lands on the post's real
address. With the cookie set, the blog's cached reads run fresh and include
drafts for that browser alone; every other visitor keeps the cache. A banner on
the previewed page leaves Draft Mode.

## Where to look

Server reads and the publish contract live in `site/src/lib/blog/`; the public
pages in `site/src/app/cut/blog/`; the CMS in `site/src/app/su/blog/`.
