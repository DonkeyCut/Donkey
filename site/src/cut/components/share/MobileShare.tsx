"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Clapperboard, FileText, Images, Loader2, MessageSquare, Captions } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { ProjectDoc, ShareFeatures, StoredAsset } from "@/cut/lib/types";
import { BottomSheet } from "./BottomSheet";
import { HlsVideo } from "./HlsVideo";

/**
 * The share as a phone should see it: the cut playing as one video, with the
 * shared surfaces reachable as sheets.
 *
 * It deliberately does not mount the editor. The editor plays a project by
 * compositing it live — a video decoder per clip, painted to a canvas — which
 * is the right design on a desktop and the wrong one on a phone, where the
 * decoders alone would exhaust what the device will give a tab. Here the cut
 * arrives already flattened, as an adaptive stream, so the phone decodes one
 * video at the rung its network can carry.
 */

type StreamState =
  | { state: "loading" }
  | { state: "ready"; url: string }
  /** No ladder to play yet, so the project's flattened proxy stands in: lower
   * resolution and one fixed bitrate, but watchable. The poll keeps running
   * underneath and swaps in the real stream the moment it exists. */
  | { state: "proxy"; url: string }
  | { state: "preparing" }
  | { state: "failed" };

type SheetId = "details" | "subtitles" | "media" | "chat";

/** First gap before re-asking for the stream. The low rungs publish well before
 * the last, so a viewer who opens a link mid-render usually waits seconds. */
const STREAM_POLL_MS = 5000;
/** Ceiling on the backoff, so a long render is still picked up promptly. */
const MAX_STREAM_POLL_MS = 60_000;
/** After this many tries the viewer keeps whatever they have. Roughly ten
 * minutes of asking with the backoff above — past that, a ladder is not coming
 * on this visit and a reload is the honest way to find out otherwise. */
const MAX_STREAM_POLLS = 12;

export function MobileShare({
  token,
  projectId,
  name,
  features,
}: {
  token: string;
  projectId: string;
  name: string;
  features: ShareFeatures;
}) {
  const api = useCallback(
    (path: string) => `/api/cut-shared/${encodeURIComponent(token)}${path}`,
    [token]
  );
  const [stream, setStream] = useState<StreamState>({ state: "loading" });
  const [doc, setDoc] = useState<ProjectDoc | null>(null);
  const [sheet, setSheet] = useState<SheetId | null>(null);
  const onStreamError = useCallback(() => setStream({ state: "failed" }), []);
  // Whether playback has begun, so the poll knows not to replace a video the
  // viewer is watching; a ref rather than state because changing it must not
  // re-render the element it is guarding.
  const startedRef = useRef(false);
  // Whether the flattened proxy has already failed for this share, so the poll
  // stops offering it again.
  const proxyFailedRef = useRef(false);

  // A ladder may still be rendering when a link is opened, and a share made
  // before ladders existed has none until its owner next edits the project.
  // Either way the viewer gets the flattened proxy rather than a spinner, and
  // the poll swaps in the real stream when it lands.
  //
  // A server error takes the same path deliberately: a viewer is not the right
  // place to report a broken deployment, and it is not hidden — the stream
  // route logs the reason and a ladder render that cannot record itself fails
  // its job outright. Only a 200 that carries no URL is terminal, since asking
  // again could not answer differently.
  //
  // The poll backs off and eventually stops. A link whose project will never
  // have a ladder would otherwise ask forever, and /stream is deliberately
  // uncached — so a link a crowd opens would put a steady origin-plus-database
  // request per viewer per tick behind it, which is the stampede the rest of
  // the share design exists to avoid.
  useEffect(() => {
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let attempt = 0;
    const proxyUrl = api(`/projects/${projectId}/preview`);
    // Fall back to the proxy, unless it has already failed for this share —
    // re-entering it then would remount a broken <video>, which errors straight
    // back to "preparing" and flickers between the two forever.
    const fallBack = () => {
      setStream(
        proxyFailedRef.current ? { state: "preparing" } : { state: "proxy", url: proxyUrl }
      );
      again();
    };
    const again = () => {
      if (attempt >= MAX_STREAM_POLLS) return;
      const delay = Math.min(
        MAX_STREAM_POLL_MS,
        STREAM_POLL_MS * Math.pow(2, Math.max(0, attempt - 1))
      );
      attempt++;
      timer = setTimeout(poll, delay);
    };
    const poll = async () => {
      try {
        const res = await fetch(api(`/projects/${projectId}/stream`));
        if (!alive) return;
        if (res.ok) {
          const body = (await res.json()) as { url?: string };
          if (body.url) {
            // Never yank a video the viewer is already watching. Swapping the
            // element mid-playback restarts the cut at zero with no
            // explanation; the better stream is worth having on the next load,
            // not at the cost of the sitting they are in.
            if (startedRef.current) return;
            return setStream({ state: "ready", url: body.url });
          }
          return setStream({ state: "failed" });
        }
        fallBack();
      } catch {
        if (!alive) return;
        fallBack();
      }
    };
    void poll();
    return () => {
      alive = false;
      if (timer) clearTimeout(timer);
    };
  }, [api, projectId]);

  // The doc backs every sheet. It is small next to the media it describes, and
  // the server has already filtered it to what this share offers.
  useEffect(() => {
    let alive = true;
    void fetch(api(`/projects/${projectId}`))
      .then((r) => (r.ok ? (r.json() as Promise<ProjectDoc>) : null))
      .then((d) => alive && setDoc(d))
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [api, projectId]);

  const sheets = useMemo(() => {
    const out: { id: SheetId; label: string; icon: React.ReactNode }[] = [];
    if (features.details) out.push({ id: "details", label: "Details", icon: <FileText /> });
    if (features.subtitles) out.push({ id: "subtitles", label: "Transcript", icon: <Captions /> });
    if (features.media || features.genai) {
      out.push({ id: "media", label: "Media", icon: <Images /> });
    }
    if (features.chat) out.push({ id: "chat", label: "Chat", icon: <MessageSquare /> });
    return out;
  }, [features]);

  return (
    <div className="flex h-[100dvh] flex-col bg-background">
      <header className="flex items-center gap-2 px-4 pt-[max(0.75rem,env(safe-area-inset-top))] pb-3">
        <Clapperboard className="size-4 shrink-0 text-muted-foreground" />
        <h1 className="truncate text-sm font-medium">{name}</h1>
      </header>

      <div className="flex min-h-0 flex-1 items-center justify-center bg-black">
        {stream.state === "ready" ? (
          <HlsVideo
            src={stream.url}
            className="max-h-full max-w-full"
            onError={onStreamError}
            onPlaying={() => (startedRef.current = true)}
          />
        ) : stream.state === "proxy" ? (
          // The endpoint redirects to the media edge, so the element can hold
          // the path directly. It 404s on its own when the project has no proxy
          // — or when the share hides Subtitles and this render has them burned
          // in — which is the case that shows "preparing".
          <video
            src={stream.url}
            controls
            playsInline
            preload="metadata"
            className="max-h-full max-w-full"
            onPlaying={() => (startedRef.current = true)}
            onError={() => {
              proxyFailedRef.current = true;
              setStream({ state: "preparing" });
            }}
          />
        ) : (
          <div className="flex flex-col items-center gap-3 px-8 text-center">
            {stream.state === "failed" ? (
              <p className="text-sm text-white/70">This project can&apos;t be played right now.</p>
            ) : (
              <>
                <Loader2 className="size-5 animate-spin text-white/70" />
                <p className="text-sm text-white/70">
                  {stream.state === "preparing"
                    ? "Getting this project ready to play…"
                    : "Loading…"}
                </p>
              </>
            )}
          </div>
        )}
      </div>

      {sheets.length > 0 && (
        <nav className="flex shrink-0 justify-around border-t border-border px-2 pt-2 pb-[max(0.5rem,env(safe-area-inset-bottom))]">
          {sheets.map((s) => (
            <Button
              key={s.id}
              variant="ghost"
              className="h-auto flex-col gap-1 px-4 py-2 text-[11px] font-normal"
              onClick={() => setSheet(s.id)}
            >
              {s.icon}
              {s.label}
            </Button>
          ))}
        </nav>
      )}

      <BottomSheet
        title={sheets.find((s) => s.id === sheet)?.label ?? ""}
        open={sheet !== null}
        onClose={() => setSheet(null)}
      >
        {sheet === "details" && <DetailsSheet doc={doc} />}
        {sheet === "subtitles" && <SubtitlesSheet doc={doc} />}
        {sheet === "media" && <MediaSheet api={api} projectId={projectId} doc={doc} />}
        {sheet === "chat" && <ChatSheet api={api} projectId={projectId} />}
      </BottomSheet>
    </div>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return <p className="py-6 text-center text-sm text-muted-foreground">{children}</p>;
}

function DetailsSheet({ doc }: { doc: ProjectDoc | null }) {
  if (!doc) return <Empty>Loading…</Empty>;
  const notes = doc.notes;
  const publish = doc.publish;
  const links = notes?.links?.filter(Boolean) ?? [];
  if (!notes?.text && !notes?.publishedAt && links.length === 0 && !publish?.caption) {
    return <Empty>No details shared.</Empty>;
  }
  return (
    <div className="flex flex-col gap-4 pb-2 text-sm">
      {publish?.caption && (
        <section className="flex flex-col gap-1">
          <h3 className="text-xs font-medium text-muted-foreground">Caption</h3>
          <p className="whitespace-pre-wrap">{publish.caption}</p>
        </section>
      )}
      {notes?.publishedAt && (
        <section className="flex flex-col gap-1">
          <h3 className="text-xs font-medium text-muted-foreground">Published</h3>
          <p>{notes.publishedAt}</p>
        </section>
      )}
      {notes?.text && (
        <section className="flex flex-col gap-1">
          <h3 className="text-xs font-medium text-muted-foreground">Notes</h3>
          <p className="whitespace-pre-wrap">{notes.text}</p>
        </section>
      )}
      {links.length > 0 && (
        <section className="flex flex-col gap-1">
          <h3 className="text-xs font-medium text-muted-foreground">Links</h3>
          {links.map((l) => (
            <a
              key={l}
              href={l}
              target="_blank"
              rel="noreferrer noopener"
              className="truncate text-primary underline"
            >
              {l}
            </a>
          ))}
        </section>
      )}
    </div>
  );
}

/** Seconds as m:ss — the transcript's only timestamp format, since a cut long
 * enough to need hours still reads fine counting minutes. */
function stamp(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

function SubtitlesSheet({ doc }: { doc: ProjectDoc | null }) {
  if (!doc) return <Empty>Loading…</Empty>;
  const cues = doc.subtitles?.cues ?? [];
  if (cues.length === 0) return <Empty>No transcript shared.</Empty>;
  return (
    <ul className="flex flex-col gap-2 pb-2 text-sm">
      {cues.map((cue, i) => (
        <li key={i} className="flex gap-3">
          <span className="shrink-0 pt-px font-mono text-xs text-muted-foreground tabular-nums">
            {stamp(cue.start)}
          </span>
          <span>{cue.text}</span>
        </li>
      ))}
    </ul>
  );
}

function MediaSheet({
  api,
  projectId,
  doc,
}: {
  api: (path: string) => string;
  projectId: string;
  doc: ProjectDoc | null;
}) {
  const [urls, setUrls] = useState<Record<string, string>>({});
  // Only assets a clip does not already use: the cut itself is the video above,
  // so this lists what the share adds to it.
  const assets = useMemo(() => {
    if (!doc) return [];
    const used = new Set([
      ...(doc.clips ?? []).map((c) => c.assetId),
      ...(doc.audioClips ?? []).map((c) => c.assetId),
    ]);
    return (doc.assets ?? []).filter((a) => !used.has(a.id) && a.type !== "audio");
  }, [doc]);

  useEffect(() => {
    if (assets.length === 0) return;
    let alive = true;
    void fetch(api("/media/presign-get"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        items: assets.map((a) => ({ projectId, fileName: a.fileName })),
      }),
    })
      .then((r) => (r.ok ? (r.json() as Promise<{ urls?: { fileName: string; url: string }[] }>) : null))
      .then((body) => {
        if (!alive || !body?.urls) return;
        setUrls(Object.fromEntries(body.urls.map((u) => [u.fileName, u.url])));
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [api, projectId, assets]);

  if (!doc) return <Empty>Loading…</Empty>;
  if (assets.length === 0) return <Empty>No media shared.</Empty>;
  return (
    <div className="grid grid-cols-3 gap-2 pb-2">
      {assets.map((a) => (
        <MediaTile key={a.id} asset={a} url={urls[a.fileName]} />
      ))}
    </div>
  );
}

function MediaTile({ asset, url }: { asset: StoredAsset; url?: string }) {
  return (
    <figure className="flex flex-col gap-1">
      <div className="aspect-square overflow-hidden rounded-md bg-muted">
        {url ? (
          asset.type === "image" ? (
            <img src={url} alt={asset.name} loading="lazy" className="size-full object-cover" />
          ) : (
            // Metadata only, and a fragment so the poster frame is a real frame
            // rather than black: a grid of autoloading videos would pull the
            // whole panel's bytes on a phone.
            <video
              src={`${url}#t=0.1`}
              preload="metadata"
              muted
              playsInline
              className="size-full object-cover"
            />
          )
        ) : null}
      </div>
      <figcaption className="truncate text-[11px] text-muted-foreground">{asset.name}</figcaption>
    </figure>
  );
}

/** A chat thread as the share stores it — the fields this read-only view needs
 * out of the payload the editor round-trips. Messages are AI SDK `UIMessage`s,
 * so their text lives in `parts` rather than on the message itself. */
interface SharedThread {
  id?: string;
  title?: string;
  messages?: { role?: string; parts?: { type?: string; text?: string }[] }[];
}

/** The readable text of one message: its text parts, joined. Tool calls and
 * attachments are other part types and are left out — this is a transcript of
 * the conversation, not a replay of the run. */
function messageText(m: NonNullable<SharedThread["messages"]>[number]): string {
  return (m.parts ?? [])
    .map((p) => (p.type === "text" ? (p.text ?? "") : ""))
    .join("")
    .trim();
}

function ChatSheet({ api, projectId }: { api: (path: string) => string; projectId: string }) {
  const [threads, setThreads] = useState<SharedThread[] | null>(null);
  useEffect(() => {
    let alive = true;
    void fetch(api(`/projects/${projectId}/chats`))
      .then((r) => (r.ok ? (r.json() as Promise<SharedThread[]>) : []))
      .then((t) => alive && setThreads(Array.isArray(t) ? t : []))
      .catch(() => alive && setThreads([]));
    return () => {
      alive = false;
    };
  }, [api, projectId]);

  if (threads === null) return <Empty>Loading…</Empty>;
  // Emptiness is decided on what will actually render, not on the message
  // count: a thread of nothing but tool calls has messages and no readable
  // text, and counting those would open a blank sheet instead of saying so.
  const shown = threads
    .flatMap((t) => t.messages ?? [])
    .map((m) => ({ role: m.role, text: messageText(m) }))
    .filter((m) => m.text.length > 0);
  if (shown.length === 0) return <Empty>No chat shared.</Empty>;
  return (
    <ul className="flex flex-col gap-3 pb-2 text-sm">
      {shown.map((m, i) => (
        <li
          key={i}
          className={
            m.role === "user"
              ? "ml-6 rounded-lg bg-muted px-3 py-2 whitespace-pre-wrap"
              : "mr-6 whitespace-pre-wrap"
          }
        >
          {m.text}
        </li>
      ))}
    </ul>
  );
}
