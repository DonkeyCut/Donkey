"use client";

// The dialog every Upload button opens: files from this computer, or from a
// phone by QR code. The phone view opens a drop for the caller's place while
// it is on screen and retires it when it goes; anything the phone already
// started still lands. Once a phone sends, the dialog widens to list each
// file with its thumbnail and progress beside the code.
import { Check, ChevronLeft, Film, ImageIcon, Monitor, Smartphone } from "lucide-react";
import { useTranslations } from "next-intl";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { encode } from "uqr";

import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { cn } from "@/lib/utils";

import { useEnvironment } from "../lib/environment";
import {
  beatPhoneDrop,
  closePhoneDrop,
  landDropFiles,
  openPhoneDrop,
  wakePhoneLanding,
  type PhoneDropFile,
  type PhoneLander,
  type PhoneTarget,
} from "../lib/phoneDrop";

/** Where a phone's files go, named for the phone's page. */
export type PhoneUpload = {
  target: PhoneTarget;
  label: string;
  /** Replace: the phone sends one file. */
  count: "one" | "many";
  /** Lands this dialog's files its own way while it is open (Replace picks
   * the file); without it they land like any other upload to the place. */
  land?: PhoneLander;
};

type View = "choose" | "phone";

/** How often the open code is kept alive and its files read. */
const BEAT_MS = 2000;

export function UploadDialog({
  open,
  onOpenChange,
  onComputer,
  phone,
  children,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Opens the caller's file picker. */
  onComputer: () => void;
  /** Null where the place cannot take a phone's files. */
  phone: PhoneUpload | null;
  /** More ways in, under the two choices: Assets' link field. */
  children?: ReactNode;
}) {
  const t = useTranslations("media.uploadDialog");
  // The ChatGPT card keeps to its frame: no hand-off to a phone.
  const { chatgpt } = useEnvironment();
  const offer = chatgpt ? null : phone;
  const [view, setView] = useState<View>("choose");
  const [files, setFiles] = useState<PhoneDropFile[]>([]);
  const wide = view === "phone" && files.length > 0;

  // Each opening starts on the choices.
  const [wasOpen, setWasOpen] = useState(open);
  if (open !== wasOpen) {
    setWasOpen(open);
    if (!open) {
      setView("choose");
      setFiles([]);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className={cn("transition-[max-width]", wide ? "sm:max-w-3xl" : "sm:max-w-md")}>
        <DialogHeader>
          <div className="flex items-center gap-1">
            {view === "phone" && (
              <Button
                variant="ghost"
                size="icon-sm"
                className="-ml-1"
                aria-label={t("back")}
                onClick={() => {
                  setView("choose");
                  setFiles([]);
                }}
              >
                <ChevronLeft />
              </Button>
            )}
            <DialogTitle>{view === "phone" ? t("fromPhone") : t("title")}</DialogTitle>
          </div>
        </DialogHeader>

        {view === "choose" ? (
          <div className="flex flex-col gap-4">
            <div className={cn("grid gap-3", offer ? "grid-cols-2" : "grid-cols-1")}>
              <Choice icon={<Monitor />} label={t("fromComputer")} onClick={onComputer} />
              {offer && <Choice icon={<Smartphone />} label={t("fromPhone")} onClick={() => setView("phone")} />}
            </div>
            {children}
          </div>
        ) : (
          offer && <PhoneView phone={offer} files={files} onFiles={setFiles} />
        )}
      </DialogContent>
    </Dialog>
  );
}

function Choice({ icon, label, onClick }: { icon: ReactNode; label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex flex-col items-center gap-2 rounded-xl border border-border py-7 text-sm font-medium transition-colors hover:bg-muted/60 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none [&_svg]:size-6 [&_svg]:text-muted-foreground"
    >
      {icon}
      {label}
    </button>
  );
}

// --- From phone ---

type Drop = { id: string; url: string };

function PhoneView({
  phone,
  files,
  onFiles,
}: {
  phone: PhoneUpload;
  files: PhoneDropFile[];
  onFiles: (files: PhoneDropFile[]) => void;
}) {
  const t = useTranslations("media.uploadDialog");
  const [drop, setDrop] = useState<Drop | null>(null);
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);

  // The caller's values change identity on every render; the drop is opened
  // for the place, so the effect keys on what names it.
  const latest = useRef(phone);
  useEffect(() => {
    latest.current = phone;
  });
  const placeKey = JSON.stringify([phone.target, phone.label, phone.count]);
  const onFilesRef = useRef(onFiles);
  useEffect(() => {
    onFilesRef.current = onFiles;
  });

  // Open a drop, keep it alive, read its files; retire it on the way out. A
  // drop whose heartbeat lapsed (the laptop slept) is replaced by a new one.
  useEffect(() => {
    let stopped = false;
    let current: Drop | null = null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let release = () => {};

    const start = async () => {
      setFailed(false);
      try {
        const { target, label, count, land } = latest.current;
        current = await openPhoneDrop(target, label, count);
        if (stopped) {
          closePhoneDrop(current.id);
          return;
        }
        release = land ? landDropFiles(current.id, land) : () => {};
        setDrop(current);
        void beat();
      } catch {
        if (!stopped) {
          setFailed(true);
        }
      }
    };

    const beat = async () => {
      if (stopped || !current) {
        return;
      }
      try {
        const next = await beatPhoneDrop(current.id);
        if (stopped) {
          return;
        }
        if (!next.open) {
          release();
          closePhoneDrop(current.id);
          current = null;
          void start();
          return;
        }
        onFilesRef.current(next.files);
        if (next.files.some((f) => f.state === "staged")) {
          wakePhoneLanding();
        }
      } catch {
        // A missed beat is retried on the next one; the window outlasts several.
      }
      timer = setTimeout(() => void beat(), BEAT_MS);
    };

    void start();
    return () => {
      stopped = true;
      clearTimeout(timer);
      release();
      if (current) {
        closePhoneDrop(current.id);
      }
    };
  }, [placeKey, attempt]);

  if (failed) {
    return (
      <div className="flex flex-col items-center gap-3 py-10 text-center">
        <p className="text-muted-foreground">{t("codeFailed")}</p>
        <Button variant="outline" onClick={() => setAttempt((n) => n + 1)}>
          {t("retry")}
        </Button>
      </div>
    );
  }

  const code = (
    <div className="flex flex-col items-center gap-4 py-2">
      <div className="rounded-2xl border border-border bg-white p-2">
        {drop ? <QrCode value={drop.url} label={t("qrLabel")} /> : <div className="size-56" />}
      </div>
      <p className="text-center text-base font-semibold">{t("scan")}</p>
    </div>
  );
  if (files.length === 0) {
    return code;
  }

  const done = files.filter((f) => f.state === "landed").length;
  return (
    <div className="grid gap-6 sm:grid-cols-[auto_minmax(0,1fr)]">
      {code}
      <div className="flex min-w-0 flex-col gap-3">
        <p className="text-sm font-medium tabular-nums">{t("progress", { done, total: files.length })}</p>
        <ul className="flex max-h-80 flex-col gap-3 overflow-y-auto pr-1">
          {files.map((f) => (
            <FileRow key={f.id} file={f} />
          ))}
        </ul>
      </div>
    </div>
  );
}

function FileRow({ file }: { file: PhoneDropFile }) {
  const t = useTranslations("media.uploadDialog");

  // The heartbeat signs a new thumbnail URL each time; the first one stays so
  // the picture does not reload every beat.
  const [shown, setShown] = useState(file.thumbUrl);
  if (!shown && file.thumbUrl) {
    setShown(file.thumbUrl);
  }

  const fraction = file.bytes > 0 ? Math.min(1, file.sentBytes / file.bytes) : 0;
  const sending = file.state === "sending";
  const status =
    file.state === "landed" ? (
      <Check className="size-4 text-emerald-600 dark:text-emerald-400" aria-label={t("added")} />
    ) : file.state === "failed" ? (
      <span className="text-destructive">{t("failed")}</span>
    ) : sending && file.sentBytes === 0 ? (
      <span className="text-muted-foreground">{t("waiting")}</span>
    ) : sending ? (
      <span className="text-muted-foreground tabular-nums">{t("percent", { value: Math.round(fraction * 100) })}</span>
    ) : (
      <span className="text-muted-foreground">{t("adding")}</span>
    );
  const Fallback = file.mime.startsWith("video/") ? Film : ImageIcon;

  return (
    <li className="flex items-center gap-3">
      <div className="flex size-9 shrink-0 items-center justify-center overflow-hidden rounded-md bg-muted">
        {shown ? (
          // eslint-disable-next-line @next/next/no-img-element -- a signed R2 URL, outside next/image's loader
          <img src={shown} alt="" className="size-full object-cover" />
        ) : (
          <Fallback className="size-4 text-muted-foreground" />
        )}
      </div>
      <div className="flex min-w-0 flex-1 flex-col gap-1.5">
        <div className="flex items-center gap-2 text-sm">
          <span className="min-w-0 flex-1 truncate">{file.name}</span>
          <span className="shrink-0 text-xs">{status}</span>
        </div>
        {(sending || file.state === "staged" || file.state === "claimed") && (
          <div className="h-1 overflow-hidden rounded-full bg-muted">
            <div
              className="h-full rounded-full bg-primary transition-[width] duration-500"
              style={{ width: `${(sending ? fraction : 1) * 100}%` }}
            />
          </div>
        )}
      </div>
    </li>
  );
}

/** A QR code as an SVG, dark modules on the white tile around it in both themes. */
function QrCode({ value, label }: { value: string; label: string }) {
  const path = useMemo(() => {
    const { data, size } = encode(value, { ecc: "M", border: 0 });
    let d = "";
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        if (data[y][x]) {
          d += `M${x} ${y}h1v1h-1z`;
        }
      }
    }
    return { d, size };
  }, [value]);

  return (
    <svg
      role="img"
      aria-label={label}
      viewBox={`-2 -2 ${path.size + 4} ${path.size + 4}`}
      className="size-56"
      shapeRendering="crispEdges"
    >
      <path d={path.d} fill="#000" />
    </svg>
  );
}
