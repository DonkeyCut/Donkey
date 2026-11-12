"use client";

import { useEffect, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import {
  ArrowUp,
  Loader2,
  Mic,
  Plus,
  RotateCcw,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  ModelSelector,
  useChatModel,
  useChatModelsInfo,
} from "@/cut/components/AiPanel";
import { MentionTextarea } from "@/cut/components/AssetRefs";
import { AssetPickerDialog } from "@/cut/components/assets/AssetPickerDialog";
import { useChatError } from "@/cut/components/chatError";
import { DictationBody } from "@/cut/components/MicDictation";
import { RefDropZone } from "@/cut/components/RefDropZone";
import {
  collectRefs,
  sameRef,
  upsertRef,
  type AssetRef,
} from "@/cut/lib/assetRef";
import { useCutCaps } from "@/cut/lib/backend/hooks";
import { useEnvironment } from "@/cut/lib/environment";
import { promptThroughHost } from "@/cut/lib/hostBridge";
import { useMicTranscription } from "@/cut/lib/micTranscribe";
import {
  ATTACHMENT_CARD,
  AudioFace,
  extensionOf,
  FaceLabel,
  FolderFace,
  FontFace,
  NoteFace,
  TextFace,
} from "@/cut/components/AttachmentFaces";
import { libraryMediaUrl } from "@/cut/lib/library";
import { AT_MENU_WIDTH, AtPicker, AtThumb } from "./AtPicker";
import { isStartTemplateRef, type AtRow } from "./atRows";
import type { useHomeCreate } from "./useHomeCreate";
import type { HomeProject } from "./useHomeProjects";
import type { UploadChip, useHomeUploads } from "./useHomeUploads";
import { useAtRows } from "./useAtRows";

type HomeUploads = ReturnType<typeof useHomeUploads>;
type HomeCreate = ReturnType<typeof useHomeCreate>;

/**
 * The prompt box that starts a project. What is written, the files dropped
 * in and the things picked with `@` or `+` become the new project's first
 * chat message; a template among them is the project's starting point.
 */
export function HomePrompt({
  uploads,
  create,
  projects,
}: {
  uploads: HomeUploads;
  create: HomeCreate;
  projects: HomeProject[];
}) {
  const t = useTranslations("home.start");
  const chatError = useChatError();
  const { chatgpt } = useEnvironment();
  const caps = useCutCaps();
  const [text, setText] = useState("");
  const [attachments, setAttachments] = useState<AssetRef[]>([]);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const [model, selectModel] = useChatModel();
  const info = useChatModelsInfo();

  // The `@` listings load the first time the box is used, not with the page.
  const [engaged, setEngaged] = useState(false);
  const rows = useAtRows(engaged, projects);
  const candidates = [...attachments, ...rows.map((r) => r.ref)];

  // Dictation lands after whatever is already written.
  const mic = useMicTranscription((said) =>
    setText((prev) => (prev.trim() ? `${prev.trim()} ${said}` : said)),
  );

  const busy = create.busy || pending;
  const hasContent =
    !!text.trim() || attachments.length > 0 || uploads.chips.length > 0;

  // Clears the box once its prompt has gone out. Home stays mounted behind
  // the editor, so a way back finds it empty.
  const reset = () => {
    setText("");
    setAttachments([]);
    uploads.clear();
  };

  // The prompt goes out: to ChatGPT inside its card, otherwise into a new
  // project whose chat sends it on arrival. Picked things and dropped files
  // ride as chips; a token typed by hand still picks its ref.
  const deliver = async () => {
    const { refs, text: plain } = collectRefs(
      text.trim(),
      [...attachments, ...uploads.refs],
      candidates,
    );

    // Inside ChatGPT the conversation is ChatGPT's: it gets the words, with
    // every picked and uploaded thing named so its tools can find it.
    if (chatgpt) {
      const names = refs.map((r) => r.name).join(", ");
      const message = [plain.trim(), names ? t("fromAssets", { names }) : ""]
        .filter(Boolean)
        .join("\n\n");
      if (message && promptThroughHost(message)) {
        reset();
      }
      return;
    }

    // A picked template is the starting point and leaves the message.
    // Example: the Recap template chip with "cut it to 30s" starts from Recap
    // and sends "cut it to 30s".
    const templates = refs.filter(isStartTemplateRef);
    const startRow = rows.find(
      (r) => r.start && templates.some((ref) => sameRef(ref, r.ref)),
    );
    const body = plain.trim();
    const rest = refs.filter((r) => !isStartTemplateRef(r));
    const first =
      body || rest.length > 0 ? { text: body, attachments: rest, model } : null;
    if (!first && !startRow?.start) {
      return;
    }
    if (await create.start("home_prompt", first, startRow?.start ?? null)) {
      reset();
    }
  };

  // A send while files are still uploading waits for them to land. A file
  // that fails holds the send so the person can retry it or take it off.
  const flush = useRef(() => {});
  useEffect(() => {
    flush.current = () => {
      setPending(false);
      if (uploads.anyFailed) {
        return;
      }
      void deliver();
    };
  });
  useEffect(() => {
    if (!pending || uploads.uploading) {
      return;
    }
    flush.current();
  }, [pending, uploads.uploading]);

  const submit = () => {
    if (!hasContent || busy) {
      return;
    }
    if (uploads.uploading) {
      setPending(true);
      return;
    }
    if (uploads.anyFailed) {
      return;
    }
    void deliver();
  };

  // Things picked in the Assets window or off the `@` menu go in as chips
  // beside the dropped files.
  const attach = (refs: AssetRef[]) => {
    setEngaged(true);
    setAttachments((list) => refs.reduce(upsertRef, list));
  };
  const addPicked = (refs: AssetRef[]) => {
    setPickerOpen(false);
    if (refs.length === 0) {
      return;
    }
    attach(refs);
    requestAnimationFrame(() => inputRef.current?.focus());
  };
  const detach = (ref: AssetRef) =>
    setAttachments((list) => list.filter((r) => !sameRef(r, ref)));

  // Backspace at the very start takes off the newest chip: a picked thing,
  // then the dropped files.
  const removeLastChip = () => {
    const picked = attachments.at(-1);
    if (picked) {
      detach(picked);
      return;
    }
    const last = uploads.chips.at(-1);
    if (last) {
      uploads.remove(last.id);
    }
  };

  const status = create.progress
    ? t("startingFrom", { name: create.progress.name })
    : (create.error ??
      uploads.error ??
      (mic.error ? chatError(mic.error) : null));

  return (
    <div className="flex w-full max-w-[760px] flex-col gap-2">
      {/* Cards dragged in from the page (a template, a Library file) land as
          chips; files from the desktop go through the page's own drop. */}
      <RefDropZone
        onRef={(ref) => attach([ref])}
        activeClassName="rounded-[26px] ring-3 ring-[#0a84ff]/50"
      >
        <div
          onFocusCapture={() => setEngaged(true)}
          className="composer-lift flex flex-col gap-2.5 rounded-[26px] border border-border bg-card px-4 py-3 transition-colors focus-within:border-foreground/40 dark:bg-[color-mix(in_oklab,var(--card),white_3%)]"
        >
          {mic.state === "idle" ? (
            <>
              {uploads.chips.length + attachments.length > 0 && (
                <div className="flex flex-wrap gap-2">
                  {uploads.chips.map((chip) => (
                    <FileChip
                      key={chip.id}
                      chip={chip}
                      onRemove={uploads.remove}
                      onRetry={uploads.retry}
                    />
                  ))}
                  {attachments.map((ref) => (
                    <RefChip
                      key={`${ref.scope}:${ref.kind}:${ref.id}`}
                      refItem={ref}
                      row={rows.find((r) => sameRef(r.ref, ref))}
                      onRemove={detach}
                    />
                  ))}
                </div>
              )}

              <MentionTextarea
                className="max-h-60 min-h-12 w-full resize-none overflow-y-auto bg-transparent p-1 text-base leading-6 outline-none placeholder:text-muted-foreground"
                rows={2}
                autoGrow
                placeholder={
                  uploads.chips.length + attachments.length > 0
                    ? t("placeholderFiles")
                    : t("placeholder")
                }
                value={text}
                onChange={setText}
                candidates={candidates}
                submitKey="enter"
                menuSide="bottom"
                inputRef={inputRef}
                onSubmit={submit}
                attachedRefs={attachments}
                onUpsertRef={(ref) =>
                  setAttachments((list) => upsertRef(list, ref))
                }
                onPasteFiles={(files) => void uploads.add(files)}
                onRemoveLastRef={removeLastChip}
                renderMenu={(menu) => <AtPicker menu={menu} rows={rows} />}
                menuWidth={AT_MENU_WIDTH}
                onPickRef={(ref) => attach([ref])}
              />

              <div className="flex flex-wrap items-center gap-2">
                <IconTip label={t("attach")}>
                  <Button
                    type="button"
                    variant="outline"
                    size="icon"
                    className="size-9 rounded-full"
                    aria-label={t("attach")}
                    onClick={() => setPickerOpen(true)}
                  >
                    <Plus className="size-[18px]" />
                  </Button>
                </IconTip>
                <div className="flex-1" />
                {/* Inside ChatGPT the chat runs on ChatGPT's own model. */}
                {!chatgpt && (
                  <ModelSelector
                    info={info}
                    model={model}
                    onSelect={selectModel}
                    className="h-9 gap-1.5 rounded-full px-3 text-[13px]"
                  />
                )}
                {caps.liveMic && (
                  <IconTip label={t("voice")}>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      className="size-9 rounded-full text-muted-foreground"
                      aria-label={t("voice")}
                      disabled={busy}
                      onClick={() => void mic.start()}
                    >
                      <Mic className="size-[18px]" />
                    </Button>
                  </IconTip>
                )}
                <IconTip label={t("send")}>
                  <Button
                    type="button"
                    size="icon"
                    className="size-9 rounded-full"
                    aria-label={t("send")}
                    disabled={!hasContent || busy}
                    onClick={submit}
                  >
                    {busy ? (
                      <Loader2 className="size-[18px] animate-spin" />
                    ) : (
                      <ArrowUp className="size-[18px]" />
                    )}
                  </Button>
                </IconTip>
              </div>
            </>
          ) : (
            <DictationBody text={text} mic={mic} />
          )}
        </div>
      </RefDropZone>

      {status && (
        <p role="status" className="px-1 text-[13px] text-muted-foreground">
          {status}
        </p>
      )}

      <AssetPickerDialog
        open={pickerOpen}
        onClose={() => setPickerOpen(false)}
        onAdd={addPicked}
      />
    </div>
  );
}

/** An icon button's name in the app's tooltip. The wrapper is the trigger, so
 * a disabled button still shows its name on hover. */
function IconTip({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger render={<span className="inline-flex" />}>
          {children}
        </TooltipTrigger>
        <TooltipContent side="bottom">{label}</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

/**
 * One attachment at the top of the box: a square card with its picture, or
 * for something with no picture, its name and a badge for its type. The name
 * shows in a tooltip, and the button on the corner takes it off. `status`
 * lays an upload's state over the card.
 */
function ChipTile({
  name,
  picture,
  status,
  onRemove,
}: {
  name: string;
  picture: React.ReactNode;
  status?: React.ReactNode;
  onRemove: () => void;
}) {
  const t = useTranslations("home.start");
  return (
    <div className="group relative shrink-0">
      <TooltipProvider>
        <Tooltip>
          <TooltipTrigger
            render={
              <div className={ATTACHMENT_CARD} />
            }
          >
            {picture}
            {status}
          </TooltipTrigger>
          <TooltipContent side="bottom">{name}</TooltipContent>
        </Tooltip>
      </TooltipProvider>
      {/* On the corner, outside the card's clip. */}
      <button
        type="button"
        aria-label={t("removeFile", { name })}
        onClick={onRemove}
        className="absolute -top-2 -right-2 grid size-6 place-items-center rounded-full border border-border bg-background text-muted-foreground opacity-0 shadow-sm transition-opacity group-hover:opacity-100 hover:text-foreground focus-visible:opacity-100 focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none pointer-coarse:opacity-100"
      >
        <X className="size-3" />
      </button>
    </div>
  );
}

/** A dropped file: its picture when it has one, else its name and type, with
 * its upload's state laid over it. */
function FileChip({
  chip,
  onRemove,
  onRetry,
}: {
  chip: UploadChip;
  onRemove: (id: string) => void;
  onRetry: (id: string) => void;
}) {
  const picture =
    chip.thumb && chip.mediaType === "video" ? (
      <video
        src={chip.thumb}
        muted
        playsInline
        preload="metadata"
        className="absolute inset-0 size-full object-cover"
      />
    ) : chip.thumb ? (
      // eslint-disable-next-line @next/next/no-img-element -- a local file's object URL
      <img
        src={chip.thumb}
        alt=""
        className="absolute inset-0 size-full object-cover"
      />
    ) : (
      <TextFace name={chip.name} badge={extensionOf(chip.name)} />
    );
  return (
    <ChipTile
      name={chip.name}
      picture={picture}
      status={<ChipStatus chip={chip} onRetry={onRetry} />}
      onRemove={() => onRemove(chip.id)}
    />
  );
}

/** A thing picked off the `@` menu, out of Assets, or dragged in from the
 * page, drawn the way Assets draws it. */
function RefChip({
  refItem,
  row,
  onRemove,
}: {
  refItem: AssetRef;
  row: AtRow | undefined;
  onRemove: (ref: AssetRef) => void;
}) {
  const t = useTranslations("home.start");
  const name = row?.label ?? refItem.name;
  // A template, snippet or project shows a picture like a clip does, so a
  // label on the picture says which it is.
  const label = row?.tab === "templates" ? t("chipTemplate") : row?.tab === "snippets" ? t("chipSnippet") : row?.tab === "projects" ? t("chipProject") : null;
  return (
    <ChipTile
      name={name}
      picture={
        <>
          <ChipFace name={name} preview={row?.preview} />
          {label && <FaceLabel>{label}</FaceLabel>}
        </>
      }
      onRemove={() => onRemove(refItem)}
    />
  );
}

/**
 * A chip's face. Pictures (clips, images, projects, templates) show
 * themselves; a sound is the green card Assets plays it from; a note is its
 * paper with its title; a folder is the folder glyph over its name; a font is
 * a specimen over its name; anything else is its name and type.
 */
function ChipFace({ name, preview }: { name: string; preview: AtRow["preview"] | undefined }) {
  if (preview?.kind === "library" && preview.asset.type === "audio") {
    const a = preview.asset;
    return <AudioFace url={libraryMediaUrl(a.proxyFile ?? a.fileName, a.residency)} duration={a.duration} name={name} />;
  }
  if (preview?.kind === "note") {
    return <NoteFace title={name} body={preview.body} colorIndex={preview.colorIndex} />;
  }
  if (preview?.kind === "icon" && preview.icon === "folder") {
    return <FolderFace name={name} />;
  }
  if (preview?.kind === "file" && preview.asset.type === "font") {
    return <FontFace name={name} />;
  }
  if (preview?.kind === "file") {
    return <TextFace name={name} badge={extensionOf(preview.asset.fileName)} />;
  }
  if (preview && preview.kind !== "icon") {
    return <AtThumb preview={preview} active={false} className="absolute inset-0 size-full rounded-none border-0" />;
  }
  return <TextFace name={name} />;
}

/** An upload's state over its picture: a spinner while it uploads, nothing
 * once it has landed, and a retry button on a red wash when it failed. */
function ChipStatus({
  chip,
  onRetry,
}: {
  chip: UploadChip;
  onRetry: (id: string) => void;
}) {
  const t = useTranslations("home.start");
  if (chip.state === "done") {
    return null;
  }
  if (chip.state === "uploading") {
    return (
      <span
        role="status"
        aria-label={t("uploading")}
        className="absolute inset-0 grid place-items-center bg-black/40 text-white"
      >
        <Loader2 className="size-5 animate-spin" />
      </span>
    );
  }
  return (
    <button
      type="button"
      aria-label={`${t("uploadFailed")}. ${t("retryUpload")}`}
      onClick={() => onRetry(chip.id)}
      className="absolute inset-0 grid place-items-center bg-destructive/70 text-white focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none"
    >
      <RotateCcw className="size-5" />
    </button>
  );
}
