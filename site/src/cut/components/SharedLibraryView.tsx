"use client";

import Link from "next/link";
import { useParams, useSearchParams } from "next/navigation";
import { Download, Folder, Loader2 } from "lucide-react";
import { buttonVariants } from "@/components/ui/button";
import { useSharedLibrary } from "@/queries/sharing";
import { ApiError } from "@/queries/apiClient";
import { librarySharePath, type SharedLibraryAsset } from "@/cut/lib/librarySharing";
import { authHrefFor } from "@/app/_components/landing/useAppEntryHref";
import { LibraryCard, LIBRARY_TILE_AREA, LIBRARY_AUDIO_TILE_AREA } from "@/cut/components/LibraryCard";
import { Lightbox } from "@/cut/components/Lightbox";
import { useCutBase } from "@/cut/lib/nav";

function Asset({ asset, token }: { asset: SharedLibraryAsset; token: string }) {
  const src = `/api/cut-shared/library/${encodeURIComponent(token)}/media/${encodeURIComponent(asset.id)}`;
  const poster = asset.hasPoster ? `${src}?poster=1` : undefined;
  return <LibraryCard
    asset={{ ...asset, addedAt: 0, residency: "cloud" }}
    area={asset.type === "audio" ? LIBRARY_AUDIO_TILE_AREA : LIBRARY_TILE_AREA}
    sharedMedia={{ src, poster, downloadHref: `${src}?download=1` }}
  />;
}

export function SharedLibraryView() {
  const { token } = useParams<{ token: string }>();
  const params = useSearchParams();
  const folder = params.get("folder");
  const offsetValue = Number(params.get("offset") ?? "0");
  const offset = Number.isSafeInteger(offsetValue) && offsetValue >= 0 ? offsetValue : 0;
  const query = useSharedLibrary(token, folder, offset);
  const base = useCutBase();
  const path = `${base.replace(/\/app$/, "")}${librarySharePath(token)}`;
  const href = (id?: string | null, page = 0) => {
    const p = new URLSearchParams();
    if (id) p.set("folder", id);
    if (page) p.set("offset", String(page));
    return `${path}${p.size ? `?${p}` : ""}`;
  };
  const data = query.data;
  const status = query.error instanceof ApiError ? query.error.status : 0;
  return <main className="app-surface min-h-dvh min-w-0 bg-background font-system text-foreground">
    <div className="mx-auto max-w-6xl px-5 py-9 sm:px-10">
      <header className="mb-8 flex items-center justify-between gap-4">
        <Link href={base} className="text-lg font-semibold">Donkey Cut</Link>
        <span className="text-xs text-muted-foreground">Shared library · View only</span>
      </header>
      {query.isPending ? <div role="status" className="grid min-h-64 place-items-center"><Loader2 aria-label="Loading shared library" className="size-5 animate-spin" /></div>
        : query.isError ? <div className="flex min-h-64 flex-col items-center justify-center gap-4 text-center">
          <p role="alert" className="text-sm text-muted-foreground">{status === 401 ? "Sign in to view this share." : status === 403 ? "You don’t have access to this share. Ask the owner to invite you." : status === 404 ? "This share link is no longer available." : "Could not load this share."}</p>
          {status === 401 || status === 403
            ? <Link href={authHrefFor("/sign-in", href(folder, offset))} className={buttonVariants()}>Sign in</Link>
            : status !== 404 && <button onClick={() => void query.refetch()} className={buttonVariants({ variant: "outline" })}>Try again</button>}
        </div> : data && <>
          <nav aria-label="Folder breadcrumb" className="mb-5 flex flex-wrap items-center gap-2 text-lg font-semibold">
            {data.trail.length ? data.trail.map((f, i) => <span key={f.id} className="flex items-center gap-2">
              {i > 0 && <span className="text-muted-foreground">/</span>}
              {i === data.trail.length - 1 ? <span>{f.name}</span> : <Link href={href(f.id)} className="text-muted-foreground hover:text-foreground">{f.name}</Link>}
            </span>) : <h1>{data.name}</h1>}
          </nav>
          {!!data.folders.length && <div className="mb-7 flex flex-wrap gap-2">
            {data.folders.map((f) => <Link key={f.id} href={href(f.id)} className="flex w-24 flex-col gap-1 rounded-xl p-2 hover:bg-muted">
              <Folder className="size-10 fill-[#8cc5ff] text-[#8cc5ff]" /><span className="line-clamp-2 text-xs font-medium">{f.name}</span>
            </Link>)}
          </div>}
          <div className="flex flex-wrap items-start gap-4">
            {data.assets.map((asset) => <Asset key={asset.id} asset={asset} token={token} />)}
          </div>
          {data.templates.map((t) => <section key={t.id} className="mt-5 rounded-xl border p-4">
            <h2 className="mb-2 text-sm font-medium">{t.name}</h2>
            <p className="mb-2 text-xs text-muted-foreground">Template media</p>
            {t.files.map((f, i) => <a key={i} className="flex items-center gap-2 py-1 text-sm hover:underline" href={`/api/cut-shared/library/${encodeURIComponent(token)}/media/${encodeURIComponent(t.id)}?${new URLSearchParams({ template: t.id, file: f.fileName, download: "1" })}`}><Download className="size-3" />{f.name}</a>)}
          </section>)}
          {!data.folders.length && !data.assets.length && !data.templates.length && <p className="py-16 text-center text-sm text-muted-foreground">This folder is empty.</p>}
          <nav aria-label="Pages" className="mt-6 flex justify-between">
            {offset > 0 ? <Link href={href(folder)} className={buttonVariants({ variant: "outline" })}>First page</Link> : <span />}
            {data.next !== null && <Link href={href(folder, data.next)} className={buttonVariants({ variant: "outline" })}>Next page</Link>}
          </nav>
        </>}
    </div>
    <Lightbox />
  </main>;
}
