"use client";

// The phone's page: pick photos and videos, send them to the place the
// computer's Upload dialog named. The code in the address buys a send pass;
// each file then goes straight to storage in 8 MiB parts, a few files at once,
// every part resent alone when it fails. Every file starts when Send is tapped
// and keeps going after the computer closes its dialog; the code only stops
// new ones.
import { Check, Loader2, X } from "lucide-react";
import { useParams } from "next/navigation";
import { useFormatter, useTranslations } from "next-intl";
import { useEffect, useRef, useState, type ChangeEvent, type ReactNode } from "react";

import { Button } from "@/components/ui/button";
import { DonkeyMark } from "@/components/DonkeyMark";
import { cn } from "@/lib/utils";

const API = "/api/cut-phone";
/** Files sent at once. Each holds one part in flight, so this is the number of
 * parallel uploads; three keeps a phone's uplink full without starving it. */
const FILES_AT_ONCE = 3;
/** Tries per part before the file is given up on. */
const PART_TRIES = 5;
const RETRY_BASE_MS = 1000;
/** The thumbnail the computer shows while the file sends. */
const THUMB_EDGE = 160;
const THUMB_QUALITY = 0.7;
const THUMB_TIMEOUT_MS = 5000;
const ACCEPT = "image/*,video/*";
/** How often the time-left estimate updates. */
const CLOCK_MS = 1000;

const HTTP_CONFLICT = 409;
const HTTP_GONE = 410;
const HTTP_TOO_MANY_REQUESTS = 429;
/** Waits for a throttled request: the firewall's window is 10 s. */
const THROTTLE_TRIES = 8;
const THROTTLE_WAIT_S = 5;
const HTTP_PAYLOAD_TOO_LARGE = 413;

type Session = { pass: string; label: string; single: boolean };

type Item = {
  key: string;
  file: File;
  preview: string;
  sent: number;
  state: "queued" | "sending" | "done" | "failed";
  why?: "expired" | "noRoom" | "failed";
};

type Screen = "opening" | "offline" | "expired" | "pick" | "review" | "sending" | "done";

/** Why a file stopped: the code closed before it started, the account has no
 * room for it, or the network gave up on it. */
class SendError extends Error {
  constructor(readonly why: NonNullable<Item["why"]>) {
    super(why);
  }
}

/** A JSON request to the phone API. A burst of small photos can outrun the
 * per-address request limit; a throttled request waits as long as it is told
 * and goes again. */
async function post(path: string, body: unknown): Promise<Response> {
  for (let attempt = 1; ; attempt++) {
    const res = await fetch(`${API}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (res.status !== HTTP_TOO_MANY_REQUESTS || attempt >= THROTTLE_TRIES) {
      return res;
    }
    const wait = Number(res.headers.get("retry-after")) || THROTTLE_WAIT_S;
    await new Promise((r) => setTimeout(r, wait * 1000));
  }
}

export function PhoneSend() {
  const t = useTranslations("upload.page");
  const { code } = useParams<{ code: string }>();
  const [screen, setScreen] = useState<Screen>("opening");
  const [session, setSession] = useState<Session | null>(null);
  const [items, setItems] = useState<Item[]>([]);
  const itemsRef = useRef(items);
  useEffect(() => {
    itemsRef.current = items;
  });

  // Trade the code for a pass. A closed code shows the expired page.
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let live = true;
    void openPass(code).then((opened) => {
      if (!live) {
        return;
      }
      if (opened === "expired" || opened === "offline") {
        setScreen(opened);
        return;
      }
      setSession(opened);
      setScreen("pick");
    });
    return () => {
      live = false;
    };
  }, [code, attempt]);

  // Picked files join the list; previews are released when they leave it.
  const add = (e: ChangeEvent<HTMLInputElement>) => {
    const picked = Array.from(e.target.files ?? []);
    e.target.value = "";
    if (picked.length === 0) {
      return;
    }
    const fresh = picked.map((file) => ({
      key: crypto.randomUUID(),
      file,
      preview: URL.createObjectURL(file),
      sent: 0,
      state: "queued" as const,
    }));
    setItems((prev) => (session?.single ? [...fresh.slice(0, 1)] : [...prev.filter((i) => i.state === "queued"), ...fresh]));
    setScreen("review");
  };
  const remove = (key: string) => {
    const gone = items.find((i) => i.key === key);
    if (gone) {
      URL.revokeObjectURL(gone.preview);
    }
    const left = items.filter((i) => i.key !== key);
    setItems(left);
    if (left.length === 0) {
      setScreen("pick");
    }
  };
  useEffect(() => () => itemsRef.current.forEach((i) => URL.revokeObjectURL(i.preview)), []);

  // --- Sending ---

  const stopRef = useRef<AbortController | null>(null);
  const [startedAt, setStartedAt] = useState(0);

  // A clock for the time-left estimate, ticking only while sending.
  const [now, setNow] = useState(0);
  useEffect(() => {
    if (screen !== "sending") {
      return;
    }
    const tick = setInterval(() => setNow(Date.now()), CLOCK_MS);
    return () => clearInterval(tick);
  }, [screen]);

  const patch = (key: string, change: Partial<Item>) =>
    setItems((prev) => prev.map((i) => (i.key === key ? { ...i, ...change } : i)));

  const send = async (only?: Set<string>) => {
    if (!session) {
      return;
    }
    const stop = new AbortController();
    stopRef.current = stop;
    setStartedAt(Date.now());
    const queue = itemsRef.current.filter((i) => (only ? only.has(i.key) : i.state === "queued"));
    for (const i of queue) {
      patch(i.key, { state: "queued", sent: 0, why: undefined });
    }
    setScreen("sending");

    const wake = holdScreenOn();

    // Every file starts now, one after another, while the code is good: a
    // started file finishes on the pass even after the computer closes its
    // dialog. The parts then go a few files at once.
    let chain: Promise<unknown> = Promise.resolve();
    const starts = queue.map((item) => {
      const started = chain.then(() => {
        if (stop.signal.aborted) {
          throw new DOMException("aborted", "AbortError");
        }
        return startFile(session.pass, item.file);
      });
      chain = started.catch(() => {});
      return started;
    });

    let next = 0;
    const worker = async () => {
      while (next < queue.length && !stop.signal.aborted) {
        const index = next++;
        const item = queue[index];
        patch(item.key, { state: "sending" });
        try {
          const started = await starts[index];
          await sendParts(session.pass, started, item.file, stop.signal, (sent) => patch(item.key, { sent }));
          patch(item.key, { state: "done", sent: item.file.size });
        } catch (e) {
          if (stop.signal.aborted) {
            patch(item.key, { state: "queued", sent: 0 });
            continue;
          }
          patch(item.key, { state: "failed", why: e instanceof SendError ? e.why : "failed" });
        }
      }
    };
    await Promise.all(Array.from({ length: FILES_AT_ONCE }, worker));
    wake.release();

    // Stop ends the files that started but never sent a part.
    for (const started of starts.slice(next)) {
      void started.then(({ fileId }) => post(`/files/${fileId}/abort`, { pass: session.pass })).catch(() => {});
    }

    if (stop.signal.aborted) {
      setScreen(itemsRef.current.some((i) => i.state === "done") ? "done" : "review");
      return;
    }
    setScreen("done");
  };

  const sendMore = () => {
    itemsRef.current.forEach((i) => URL.revokeObjectURL(i.preview));
    setItems([]);
    setScreen("pick");
  };

  // --- Screens ---

  if (screen === "opening") {
    return (
      <Shell centered>
        <Loader2 className="size-6 animate-spin text-muted-foreground" />
      </Shell>
    );
  }
  if (screen === "expired" || screen === "offline") {
    return (
      <Shell centered>
        <div className="size-16">
          <DonkeyMark />
        </div>
        <p className="text-lg font-semibold">{screen === "expired" ? t("expired") : t("offline")}</p>
        {screen === "offline" && (
          <Button
            variant="outline"
            size="lg"
            onClick={() => {
              setScreen("opening");
              setAttempt((n) => n + 1);
            }}
          >
            {t("retry")}
          </Button>
        )}
      </Shell>
    );
  }
  if (!session) {
    return null;
  }

  const pickers = (
    <>
      <PickButton primary label={t("photosVideos")} multiple={!session.single} onChange={add} />
      <PickButton label={t("camera")} capture onChange={add} />
    </>
  );

  if (screen === "pick") {
    return (
      <Shell>
        <Header />
        <div className="flex flex-1 flex-col justify-center gap-2 py-8">
          <h1 className="text-3xl font-semibold tracking-tight break-words">{session.label}</h1>
        </div>
        <div className="flex flex-col gap-3">{pickers}</div>
      </Shell>
    );
  }

  if (screen === "review") {
    const bytes = items.reduce((n, i) => n + i.file.size, 0);
    return (
      <Shell>
        <Header />
        <div className="flex items-baseline justify-between gap-3 pt-6 pb-3">
          <h1 className="text-2xl font-semibold tracking-tight">{t("selected", { count: items.length })}</h1>
          <Size bytes={bytes} />
        </div>
        <Grid>
          {items.map((i) => (
            <Thumb key={i.key} item={i}>
              <button
                type="button"
                aria-label={t("remove", { name: i.file.name })}
                onClick={() => remove(i.key)}
                className="absolute top-1.5 right-1.5 grid size-7 place-items-center rounded-full bg-black/60 text-white"
              >
                <X className="size-4" />
              </button>
            </Thumb>
          ))}
        </Grid>
        <div className="flex flex-col gap-3 pt-4">
          <Button size="lg" className="h-14 rounded-2xl text-base" onClick={() => void send()}>
            {t("send", { label: session.label })}
          </Button>
        </div>
      </Shell>
    );
  }

  const total = items.length;
  const done = items.filter((i) => i.state === "done").length;
  const failed = items.filter((i) => i.state === "failed");

  if (screen === "sending") {
    const all = items.reduce((n, i) => n + i.file.size, 0);
    const sent = items.reduce((n, i) => n + (i.state === "done" ? i.file.size : i.sent), 0);
    const fraction = all > 0 ? sent / all : 0;
    return (
      <Shell>
        <Header
          action={
            <Button variant="ghost" onClick={() => stopRef.current?.abort()}>
              {t("stop")}
            </Button>
          }
        />
        <h1 className="pt-6 pb-4 text-2xl font-semibold tracking-tight break-words">{session.label}</h1>
        <div className="flex flex-col gap-2 pb-4">
          <div className="flex items-baseline justify-between text-sm">
            <span className="font-medium tabular-nums">{t("progress", { done, total })}</span>
            <Remaining fraction={fraction} startedAt={startedAt} now={now} />
          </div>
          <div className="h-1.5 overflow-hidden rounded-full bg-muted">
            <div className="h-full rounded-full bg-primary transition-[width] duration-300" style={{ width: `${fraction * 100}%` }} />
          </div>
        </div>
        <Grid>
          {items.map((i) => (
            <Thumb key={i.key} item={i} />
          ))}
        </Grid>
        <p className="pt-4 text-center text-sm text-muted-foreground">{t("screenOn")}</p>
      </Shell>
    );
  }

  // Done: what landed, and anything to resend.
  const noRoom = failed.some((i) => i.why === "noRoom");
  const expired = failed.length > 0 && failed.every((i) => i.why === "expired");
  return (
    <Shell centered>
      <div className="grid size-16 place-items-center rounded-full bg-emerald-600/10 text-emerald-600 dark:bg-emerald-400/15 dark:text-emerald-400">
        <Check className="size-8" />
      </div>
      <div className="flex flex-col items-center gap-1 text-center">
        <p className="text-2xl font-semibold">{t("added", { count: done })}</p>
        <p className="text-muted-foreground break-words">{t("to", { label: session.label })}</p>
        {failed.length > 0 && (
          <p className="pt-2 text-sm text-destructive">
            {expired ? t("expired") : noRoom ? t("noRoom") : t("notSent", { count: failed.length })}
          </p>
        )}
      </div>
      <div className="flex w-full flex-col gap-3 pt-4">
        {failed.length > 0 && !expired && !noRoom && (
          <Button size="lg" className="h-14 rounded-2xl text-base" onClick={() => void send(new Set(failed.map((i) => i.key)))}>
            {t("retry")}
          </Button>
        )}
        {!session.single && !expired && (
          <Button variant="outline" size="lg" className="h-14 rounded-2xl text-base" onClick={sendMore}>
            {t("sendMore")}
          </Button>
        )}
      </div>
    </Shell>
  );
}

// --- Pieces ---

function Shell({ children, centered = false }: { children: ReactNode; centered?: boolean }) {
  return (
    <main className="app-surface min-h-[100dvh] bg-background font-system text-foreground antialiased">
      <div
        className={cn(
          "mx-auto flex min-h-[100dvh] w-full max-w-md flex-col px-5 pt-[max(1rem,env(safe-area-inset-top))] pb-[max(1.25rem,env(safe-area-inset-bottom))]",
          centered && "items-center justify-center gap-4",
        )}
      >
        {children}
      </div>
    </main>
  );
}

function Header({ action }: { action?: ReactNode }) {
  const t = useTranslations("upload.page");
  return (
    <header className="flex h-11 items-center gap-2">
      <div className="size-7">
        <DonkeyMark />
      </div>
      <span className="flex-1 text-base font-semibold">{t("brand")}</span>
      {action}
    </header>
  );
}

function PickButton({
  label,
  primary = false,
  multiple = false,
  capture = false,
  onChange,
}: {
  label: string;
  primary?: boolean;
  multiple?: boolean;
  capture?: boolean;
  onChange: (e: ChangeEvent<HTMLInputElement>) => void;
}) {
  return (
    <label
      className={cn(
        "flex h-14 cursor-pointer items-center justify-center rounded-2xl text-base font-medium transition-colors focus-within:ring-2 focus-within:ring-ring",
        primary ? "bg-primary text-primary-foreground active:bg-primary/90" : "border border-border bg-background active:bg-muted",
      )}
    >
      {label}
      <input
        type="file"
        accept={ACCEPT}
        multiple={multiple}
        capture={capture ? "environment" : undefined}
        className="sr-only"
        onChange={onChange}
      />
    </label>
  );
}

function Grid({ children }: { children: ReactNode }) {
  return <ul className="grid flex-1 auto-rows-min grid-cols-3 content-start gap-1.5 sm:grid-cols-4">{children}</ul>;
}

function Thumb({ item, children }: { item: Item; children?: ReactNode }) {
  const video = item.file.type.startsWith("video/");
  const fraction = item.file.size > 0 ? item.sent / item.file.size : 0;
  return (
    <li className="relative aspect-square overflow-hidden rounded-lg bg-muted">
      {video ? (
        <video src={`${item.preview}#t=0.1`} muted playsInline preload="metadata" className="size-full object-cover" />
      ) : (
        // eslint-disable-next-line @next/next/no-img-element -- a local object URL
        <img src={item.preview} alt="" className="size-full object-cover" />
      )}
      {item.state === "done" && (
        <span className="absolute right-1.5 bottom-1.5 grid size-6 place-items-center rounded-full bg-emerald-600 text-white">
          <Check className="size-3.5" />
        </span>
      )}
      {item.state === "failed" && <span className="absolute inset-0 bg-black/40" />}
      {item.state === "sending" && (
        <span className="absolute inset-x-1.5 bottom-1.5 h-1 overflow-hidden rounded-full bg-black/40">
          <span className="block h-full rounded-full bg-white transition-[width] duration-300" style={{ width: `${fraction * 100}%` }} />
        </span>
      )}
      {children}
    </li>
  );
}

function Size({ bytes }: { bytes: number }) {
  const t = useTranslations("upload.page");
  const format = useFormatter();
  const units = ["byte", "kilobyte", "megabyte", "gigabyte"] as const;
  let value = bytes;
  let unit = 0;
  while (value >= 1000 && unit < units.length - 1) {
    value /= 1000;
    unit++;
  }
  const size = format.number(value, { style: "unit", unit: units[unit], unitDisplay: "short", maximumFractionDigits: 1 });
  return (
    <span className="shrink-0 text-sm text-muted-foreground">{t("fullQuality", { size })}</span>
  );
}

/** Time left at the rate so far. */
function Remaining({ fraction, startedAt, now }: { fraction: number; startedAt: number; now: number }) {
  const t = useTranslations("upload.page");
  if (fraction <= 0.02 || fraction >= 1 || now <= startedAt) {
    return null;
  }
  const leftMs = ((now - startedAt) / fraction) * (1 - fraction);
  const minutes = Math.round(leftMs / 60_000);
  return (
    <span className="text-muted-foreground">{minutes < 1 ? t("underMinute") : t("aboutMinutes", { minutes })}</span>
  );
}

// --- Transfer ---

/** The send pass for a code, or why there is none. */
async function openPass(code: string): Promise<Session | "expired" | "offline"> {
  try {
    const res = await post("/open", { code });
    return res.ok ? ((await res.json()) as Session) : "expired";
  } catch {
    return "offline";
  }
}

/** A file the pass started, and the part size to cut it into. */
type Started = { fileId: string; partBytes: number };

/** Start one file: only while the code is good. */
async function startFile(pass: string, file: File): Promise<Started> {
  const res = await post("/files", { pass, name: file.name, mime: file.type, bytes: file.size });
  if (res.status === HTTP_GONE) {
    throw new SendError("expired");
  }
  if (res.status === HTTP_PAYLOAD_TOO_LARGE) {
    throw new SendError("noRoom");
  }
  if (res.status === HTTP_CONFLICT || !res.ok) {
    throw new SendError("failed");
  }
  return (await res.json()) as Started;
}

/** Send a started file's parts in order, then join them. */
async function sendParts(
  pass: string,
  { fileId, partBytes }: Started,
  file: File,
  signal: AbortSignal,
  onSent: (bytes: number) => void,
) {
  void sendThumb(pass, fileId, file);

  try {
    const parts = Math.max(1, Math.ceil(file.size / partBytes));
    let done = 0;
    for (let n = 1; n <= parts; n++) {
      const chunk = file.slice((n - 1) * partBytes, Math.min(file.size, n * partBytes));
      await sendPart(pass, fileId, n, chunk, done, signal, (bytes) => onSent(done + bytes));
      done += chunk.size;
      onSent(done);
    }
    await withRetries(signal, async () => {
      const r = await post(`/files/${fileId}/complete`, { pass });
      if (!r.ok) {
        throw new Error(`complete ${r.status}`);
      }
    });
  } catch (e) {
    void post(`/files/${fileId}/abort`, { pass }).catch(() => {});
    throw e;
  }
}

/** One part: a fresh URL for each try, so an expired signature never sticks. */
async function sendPart(
  pass: string,
  fileId: string,
  part: number,
  chunk: Blob,
  sentBefore: number,
  signal: AbortSignal,
  onProgress: (bytes: number) => void,
) {
  await withRetries(signal, async () => {
    const res = await post(`/files/${fileId}/parts`, { pass, sent: sentBefore, parts: [part] });
    if (!res.ok) {
      throw new Error(`parts ${res.status}`);
    }
    const { urls } = (await res.json()) as { urls: Record<number, string> };
    await putWithProgress(urls[part], chunk, signal, onProgress);
  });
}

/** PUT a blob, reporting bytes as they leave. Fetch has no upload progress. */
function putWithProgress(url: string, body: Blob, signal: AbortSignal, onProgress: (bytes: number) => void) {
  return new Promise<void>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("PUT", url);
    xhr.upload.onprogress = (e) => onProgress(e.loaded);
    xhr.onload = () => (xhr.status >= 200 && xhr.status < 300 ? resolve() : reject(new Error(`part ${xhr.status}`)));
    xhr.onerror = () => reject(new Error("part network"));
    xhr.onabort = () => reject(new DOMException("aborted", "AbortError"));
    signal.addEventListener("abort", () => xhr.abort(), { once: true });
    xhr.send(body);
  });
}

/** Try again with a growing wait. A page in the background waits to be seen
 * before trying, so a phone that locked mid-send picks up where it was. */
async function withRetries(signal: AbortSignal, work: () => Promise<void>) {
  for (let attempt = 1; ; attempt++) {
    await visible(signal);
    try {
      await work();
      return;
    } catch (e) {
      if (signal.aborted) {
        throw e;
      }
      if (document.visibilityState === "hidden") {
        attempt--;
        continue;
      }
      if (attempt >= PART_TRIES) {
        throw e;
      }
      await new Promise((r) => setTimeout(r, RETRY_BASE_MS * 2 ** (attempt - 1)));
    }
  }
}

function visible(signal: AbortSignal) {
  if (document.visibilityState === "visible" || signal.aborted) {
    return Promise.resolve();
  }
  return new Promise<void>((resolve) => {
    const done = () => {
      if (document.visibilityState === "visible" || signal.aborted) {
        document.removeEventListener("visibilitychange", done);
        resolve();
      }
    };
    document.addEventListener("visibilitychange", done);
    signal.addEventListener("abort", done, { once: true });
  });
}

/** Keep the screen awake while sending, taking the lock back each time the
 * page comes back into view (the browser drops it when hidden). */
function holdScreenOn() {
  let lock: WakeLockSentinel | null = null;
  let held = true;
  const take = () => {
    if (!held || document.visibilityState !== "visible" || !("wakeLock" in navigator)) {
      return;
    }
    navigator.wakeLock.request("screen").then(
      (l) => {
        lock = l;
      },
      () => {},
    );
  };
  take();
  document.addEventListener("visibilitychange", take);
  return {
    release: () => {
      held = false;
      document.removeEventListener("visibilitychange", take);
      void lock?.release().catch(() => {});
    },
  };
}

/** A small JPEG of the file for the computer's list. Best effort: a file the
 * browser cannot draw sends without one. */
async function sendThumb(pass: string, fileId: string, file: File) {
  try {
    const blob = await thumbnailOf(file);
    if (!blob) {
      return;
    }
    await fetch(`${API}/files/${fileId}/thumb`, { method: "PUT", headers: { "x-phone-pass": pass, "Content-Type": "image/jpeg" }, body: blob });
  } catch {
    // The list shows the file's kind instead.
  }
}

async function thumbnailOf(file: File): Promise<Blob | null> {
  const url = URL.createObjectURL(file);
  const video = file.type.startsWith("video/") ? document.createElement("video") : null;
  try {
    const source = await Promise.race([
      video ? videoFrame(video, url) : imageOf(url),
      new Promise<null>((r) => setTimeout(() => r(null), THUMB_TIMEOUT_MS)),
    ]);
    if (!source) {
      return null;
    }
    const { el, width, height } = source;
    const scale = THUMB_EDGE / Math.max(width, height);
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(width * scale));
    canvas.height = Math.max(1, Math.round(height * scale));
    canvas.getContext("2d")?.drawImage(el, 0, 0, canvas.width, canvas.height);
    return await new Promise<Blob | null>((r) => canvas.toBlob(r, "image/jpeg", THUMB_QUALITY));
  } finally {
    // The video's decoder goes with the thumbnail, drawn or timed out.
    if (video) {
      video.removeAttribute("src");
      video.load();
    }
    URL.revokeObjectURL(url);
  }
}

function imageOf(url: string) {
  return new Promise<{ el: HTMLImageElement; width: number; height: number } | null>((resolve) => {
    const img = new Image();
    img.onload = () => resolve({ el: img, width: img.naturalWidth, height: img.naturalHeight });
    img.onerror = () => resolve(null);
    img.src = url;
  });
}

function videoFrame(video: HTMLVideoElement, url: string) {
  return new Promise<{ el: HTMLVideoElement; width: number; height: number } | null>((resolve) => {
    video.muted = true;
    video.playsInline = true;
    video.preload = "auto";
    video.onloadeddata = () => {
      video.currentTime = Math.min(0.1, video.duration || 0);
    };
    video.onseeked = () => resolve({ el: video, width: video.videoWidth, height: video.videoHeight });
    video.onerror = () => resolve(null);
    video.src = url;
  });
}
