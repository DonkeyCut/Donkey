"use client";

import { Fragment, memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useChat } from "@ai-sdk/react";
import { DefaultChatTransport, type ChatTransport, type UIMessage } from "ai";
import {
  ArrowUp,
  Brain,
  Check,
  ChevronLeft,
  ChevronDown,
  CircleDashed,
  Copy,
  Ellipsis,
  ExternalLink,
  FolderPlus,
  History,
  Maximize2,
  Mic,
  Plus,
  Sparkles,
  Square,
  Star,
  Trash2,
  TriangleAlert,
  Wrench,
  X,
} from "lucide-react";
import Markdown, { type Components } from "react-markdown";
import { baseMarkdownComponents } from "./markdownComponents";
import { LiveElapsed } from "./Elapsed";
import { SceneCard } from "./SceneCard";
import { useElapsed } from "@/cut/hooks/useElapsed";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { engineReady } from "@/cut/lib/api";
import { useCutCaps, useLocalCompute } from "@/cut/lib/backend/hooks";
import { localBackend } from "@/cut/lib/backend/local";
import { buildAiContext } from "@/cut/lib/aiContext";
import { runAiTool } from "@/cut/lib/aiTools";
import { setAssetDragData } from "@/cut/lib/assetDrag";
import { registerChatIntake } from "@/cut/lib/chatIntake";
import { videoModel } from "@/cut/lib/videoModels";
import {
  readActiveChat,
  readRawThreads,
  writeActiveChat,
  writeRawThreads,
} from "@/cut/lib/chatThreads";
import {
  deleteCloudThread,
  ensureCloudThreads,
  flushCloudThreadSaves,
  queueCloudThreadSave,
} from "@/cut/lib/chatCloud";
import {
  beginChatTurn,
  deleteChatAssets,
  endChatTurn,
  setActiveChatThread,
  threadOwnsAssets,
} from "@/cut/lib/chatAssets";
import { threadHasLiveRun } from "@/cut/lib/genScene";
import {
  addRefOnce,
  collectRefs,
  normalizeRef,
  sameRef,
  setRefDragData,
  splitMentions,
  upsertRef,
  useRefCandidates,
  useAssetDrop,
  type AssetRef,
} from "@/cut/lib/assetRef";
import {
  creditsUrl,
  useGenerate,
  useSignedIn,
} from "@/cut/lib/generate";
import { useCreditsRecheck, useOutOfCredits } from "@/cut/lib/hosted";
import { hydratePiSession, readPiSession, streamCutChat } from "@/cut/lib/pi/cutAgent";
import { productionDeps } from "@/cut/lib/pi/prodDeps";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { AI_MODELS } from "@/cut/lib/aiModels";
import { saveAssetToLibrary } from "@/cut/lib/library";
import { formatDuration, useGenScene } from "@/cut/lib/genScene";
import { lightboxItemFromRef, useLightbox } from "@/cut/lib/lightbox";
import { refsFromDroppedFiles } from "@/cut/lib/refMedia";
import { revealRef } from "@/cut/lib/refReveal";
import { useEditor } from "@/cut/lib/store";
import { cn } from "@/lib/utils";
import { cardIconButton } from "@/cut/components/iconButton";
import { MentionTextarea, RefChips, RefThumb, RefTokenChip } from "./AssetRefs";
import { ComposerQueue, type QueuedMessage } from "./ComposerQueue";
import { DictationBody } from "./MicDictation";
import { RECORD_RUNNING_TTL_MS, ToolOutputAssets } from "./ChatAssets";
import { HostedErrorText } from "./hostedError";
import { useMicTranscription } from "@/cut/lib/micTranscribe";

// Chat attachments are asset refs — anything in the project, the library, or
// the stock catalog. They arrive by drag (media cards, library clips, stock
// tiles, timeline clips, the preview) or as @name mentions in the message.

interface ModelsInfo {
  // A CLI provider's group lists only on `installed` true — unknown (probe
  // still out, or no engine) reads as absent. A provider that is installed
  // but unavailable (e.g. signed out) still lists with its note.
  providers: Record<string, { available: boolean; note: string; installed?: boolean }>;
}

/** A saved chat thread, persisted per project in localStorage. */
interface ChatThread {
  id: string;
  title: string;
  updatedAt: number;
  messages: UIMessage[];
  /** Provider-native session ids so a resumed thread keeps its context. */
  sessions: Record<string, string>;
  /** The pi loop's LLM context (structured tool history included), when the
   * thread has run on it. */
  pi?: AgentMessage[];
}


const THREAD_LIMIT = 30;
// How long a streaming turn's newest snapshot may park before it must land —
// the same cadence the cloud mirror debounces on.
const THREAD_SAVE_MS = 1500;

function readThreads(projectId: string): ChatThread[] {
  return readRawThreads(projectId) as ChatThread[];
}

/** Persisted copies drop frame payloads (data URLs) from tool outputs — one
 * watch_video result carries ~1MB of contact sheets and localStorage holds a
 * few MB per origin. The live thread keeps its images; replayed turns only
 * ever reuse text parts, so nothing downstream misses them. */
function slimForStorage(list: ChatThread[]): ChatThread[] {
  const bulky = (v: unknown) =>
    typeof v === "string" && v.startsWith("data:image/");
  // The pi session's inline media (tool frames and sound, attachment payloads)
  // stays out of storage the same way. Each drop leaves a note where the media
  // was, so a replayed turn never promises an attachment that is no longer
  // there — the model re-fetches what it still needs.
  const slimNote =
    "[The media here was dropped from the saved chat. Fetch what you still need with the media tools (listen_audio, watch_video, capture_frame).]";
  const slimPi = (msgs: AgentMessage[]): AgentMessage[] =>
    msgs.map((m) => {
      const anyM = m as unknown as Record<string, unknown>;
      let out = anyM;
      const details = anyM.details as { mediaParts?: unknown[] } | undefined;
      if (details?.mediaParts?.length)
        out = { ...out, details: { ...details, mediaParts: [{ text: slimNote }] } };
      const wireParts = anyM.wireParts as Record<string, unknown>[] | undefined;
      if (wireParts?.some((p) => typeof p.dataBase64 === "string"))
        out = {
          ...out,
          wireParts: [
            ...wireParts.filter((p) => typeof p.dataBase64 !== "string"),
            { text: slimNote },
          ],
        };
      if (
        anyM.role === "user" &&
        Array.isArray(anyM.content) &&
        (anyM.content as { type: string }[]).some((c) => c.type === "image")
      )
        out = {
          ...out,
          content: [
            ...(anyM.content as { type: string }[]).filter((c) => c.type !== "image"),
            { type: "text", text: slimNote },
          ],
        };
      return out as unknown as AgentMessage;
    });
  return list.map((t) => ({
    ...t,
    ...(t.pi ? { pi: slimPi(t.pi) } : {}),
    messages: t.messages.map((m) => ({
      ...m,
      parts: m.parts.map((p) => {
        if (m.role === "assistant" && p.type === "text" && p.text.includes("<")) {
          const clean = sanitizeAssistantText(p.text);
          if (clean !== p.text) return { ...p, text: clean };
        }
        const out = (p as { output?: unknown }).output;
        if (!out || typeof out !== "object") return p;
        const o = out as Record<string, unknown>;
        if (
          !bulky(o.image) &&
          !(Array.isArray(o.images) && o.images.some(bulky))
        )
          return p;
        return {
          ...p,
          output: {
            ...o,
            image: undefined,
            images: undefined,
            imagesOmitted: true,
          },
        } as typeof p;
      }),
    })),
  }));
}

/** A saved thread can hold tool parts captured mid-run — the page closed or
 * the stream died before the result landed. Nothing settles them after a
 * reload, so they'd show a live spinner forever; restore them as failed. */
function settleInterruptedTools(messages: UIMessage[]): UIMessage[] {
  return messages.map((m) => ({
    ...m,
    parts: m.parts.map((p) => {
      const t = p as { type: string; state?: string };
      if (!isToolPartType(t.type)) return p;
      if (t.state === "output-available" || t.state === "output-error") return p;
      return { ...p, state: "output-error", errorText: "Interrupted." } as typeof p;
    }),
  }));
}

function writeThreads(projectId: string, list: ChatThread[]) {
  // Cap history, but retain any overflow thread that still owns chat media or
  // a working scene run — killing media or work is an explicit act (deleting
  // its thread), never a side effect of the history cap.
  const kept = [
    ...list.slice(0, THREAD_LIMIT),
    ...list
      .slice(THREAD_LIMIT)
      .filter((t) => threadOwnsAssets(t.id) || threadHasLiveRun(t.id)),
  ];
  // A pruned thread is gone the way a deleted one is — anything it still
  // owned (by construction nothing live) dies with it, cloud copy included.
  const keptIds = new Set(kept.map((t) => t.id));
  for (const t of list) {
    if (!keptIds.has(t.id)) {
      useGenScene.getState().killThread(t.id);
      deleteCloudThread(projectId, t.id);
      if (typeof window !== "undefined")
        localStorage.removeItem(queueKey(projectId, t.id));
    }
  }
  writeRawThreads(projectId, slimForStorage(kept));
}

const MODEL_KEY = "cut-ai-model";
const FAVS_KEY = "cut-ai-favs";

// Waiting composer-queue rows, saved per thread so a reload or a project
// switch brings them back. Running and done rows stay out — their turns die
// with the page.
const queueKey = (projectId: string, threadId: string) =>
  `cut-ai-queue-${projectId}-${threadId}`;
function readStoredQueue(
  projectId: string,
  threadId: string,
): QueuedMessage[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = localStorage.getItem(queueKey(projectId, threadId));
    if (!raw) return [];
    return (JSON.parse(raw) as QueuedMessage[])
      .filter(
        (m) =>
          m?.status === "queued" &&
          typeof m.id === "string" &&
          typeof m.text === "string",
      )
      .map((m) => ({
        ...m,
        attachments: Array.isArray(m.attachments) ? m.attachments : [],
      }));
  } catch {
    return [];
  }
}
// A fresh user starts on Gemini — it runs on their signed-in Donkey account, so
// it works without a local CLI. Claude/Codex show up automatically once the
// engine probes them installed. The choice persists, so this is first-run only.
const DEFAULT_MODEL =
  AI_MODELS.find((m) => m.provider === "gemini" && !m.hidden)?.id ?? "gemini";
const PROVIDER_LABEL: Record<string, string> = {
  claude: "Claude Code",
  codex: "Codex",
  gemini: "Gemini",
  test: "Testing",
};

const SUGGESTIONS = [
  "What's in this video?",
  "Add transitions between clips",
  "Improve my title",
  "Watch and create subtitles",
  "Rewrite subtitles for social",
  "Write my post caption + tags",
];

/** Chat provider bucket for a model id. */
const provider = (id: string): string =>
  id.startsWith("claude")
    ? "claude"
    : id.startsWith("gemini")
      ? "gemini"
      : id === "cut-test"
        ? "test"
        : "codex";

export function AiPanel({
  projectId,
  onClose,
}: {
  projectId: string;
  onClose: () => void;
}) {
  const [info, setInfo] = useState<ModelsInfo | null>(null);
  const engineUp = useLocalCompute();
  const readOnly = useEditor((s) => s.readOnly);
  const signedIn = useSignedIn();
  // A saved id whose model left the catalog (a retired model after a bump)
  // falls back to the default; passed through, the hosted route rejects it.
  const [model, setModel] = useState<string>(() => {
    if (typeof window === "undefined") return DEFAULT_MODEL;
    const saved = localStorage.getItem(MODEL_KEY);
    return saved && AI_MODELS.some((m) => m.id === saved)
      ? saved
      : DEFAULT_MODEL;
  });
  // One chat is active at a time; every past chat lives in the Threads panel.
  // The id persists so closing and reopening the panel resumes the same chat.
  const [activeChat, setActiveChat] = useState<string>(() =>
    typeof window === "undefined"
      ? crypto.randomUUID()
      : (readActiveChat(projectId) ?? crypto.randomUUID()),
  );
  useEffect(() => {
    writeActiveChat(projectId, activeChat);
  }, [activeChat, projectId]);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [threads, setThreads] = useState<ChatThread[]>([]);
  // A cloud project's server threads merge into localStorage before the
  // session reads it, so a project opened on another device resumes its chats.
  const [chatsReady, setChatsReady] = useState(false);
  useEffect(() => {
    let alive = true;
    void ensureCloudThreads(projectId).then(() => {
      if (alive) setChatsReady(true);
    });
    return () => {
      alive = false;
    };
  }, [projectId]);

  // A shared view opens on the owner's newest thread — the viewer has no chat
  // of their own to resume. Derived, so the fallback holds until the viewer
  // explicitly opens another thread from the list.
  const sessionThread = useMemo(() => {
    if (!readOnly || !chatsReady) return activeChat;
    const list = readThreads(projectId);
    if (list.length === 0 || list.some((t) => t.id === activeChat)) return activeChat;
    return list[0].id;
  }, [readOnly, chatsReady, projectId, activeChat]);

  useEffect(() => {
    // The models probe asks the engine which CLIs are installed. The CLIs live
    // on this Mac, so the engine being reachable is what decides — whatever
    // backend holds the project. Without one there is no engine to ask
    // (mergedInfo synthesizes the Gemini-only provider set instead).
    if (!engineUp) return;
    let alive = true;
    void localBackend
      .fetch("/api/cut/ai/models")
      .then((r) => r.json())
      .then((d: ModelsInfo) => alive && setInfo(d))
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [engineUp]);

  const newChat = () => {
    setActiveChat(crypto.randomUUID());
    setHistoryOpen(false);
  };

  const openThread = (t: ChatThread) => {
    setActiveChat(t.id);
    setHistoryOpen(false);
  };

  const toggleHistory = () => {
    if (!historyOpen) setThreads(readThreads(projectId));
    setHistoryOpen((v) => !v);
  };

  const deleteThread = (id: string) => {
    writeThreads(
      projectId,
      readThreads(projectId).filter((t) => t.id !== id),
    );
    setThreads((p) => p.filter((t) => t.id !== id));
    // The thread's chat-only assets go with it; anything placed or filed
    // into Media/Library stays.
    deleteChatAssets(id);
    deleteCloudThread(projectId, id);
    localStorage.removeItem(queueKey(projectId, id));
    // Its work dies with it too: a scene run the thread owned aborts and its
    // plan clears — nothing keeps running behind a conversation the user killed.
    useGenScene.getState().killThread(id);
    // If the open chat was deleted, start a fresh one so it can't re-save
    // itself on the next message and resurrect the thread.
    if (activeChat === id) setActiveChat(crypto.randomUUID());
  };

  const selectModel = (id: string) => {
    setModel(id);
    localStorage.setItem(MODEL_KEY, id);
  };

  // Gemini runs on the user's Donkey account, so its availability is the
  // sign-in probe, not the engine's CLI checks. Signed-in state (or a probe
  // still in flight) leaves it usable; a definite signed-out disables it.
  const mergedInfo = useMemo<ModelsInfo | null>(() => {
    const gemini =
      signedIn === false
        ? { available: false, note: "sign in to Donkey to chat", installed: true }
        : (info?.providers.gemini ?? { available: true, note: "", installed: true });
    // With no engine on this Mac the CLI providers don't exist: their groups
    // hide, and the saved-model fallback effect moves a CLI selection over to
    // Gemini.
    if (!engineUp) {
      const off = { available: false, note: "", installed: false };
      const providers: ModelsInfo["providers"] = { claude: off, codex: off, test: off, gemini };
      return { providers };
    }
    if (!info) return null;
    return { ...info, providers: { ...info.providers, gemini } };
  }, [info, signedIn, engineUp]);

  return (
    // A column beside the editor, as it has always been. Docking costs the
    // editor 340px and it wears that down to a narrow window, taking the
    // content over with it; only once the window itself is under the width the
    // editor needs to be worth opening — NARROW_MAX_WIDTH, 900 — is there
    // nothing left to take, and the panel lifts off and overlays instead.
    //
    // A plain overlay, with no scrim: the cut stays readable behind it, which
    // is the point of having it open. Fixed rather than absolute so it is the
    // viewport it pins to, not the editor's box — narrower than the panel and
    // that box is wider than the screen, and the panel would hang off it.
    <aside className="ai-panel relative flex min-h-0 w-[340px] shrink-0 animate-in flex-col border-l border-border bg-card duration-300 ease-out slide-in-from-right-full max-[900px]:fixed max-[900px]:inset-y-0 max-[900px]:right-0 max-[900px]:z-50 max-[900px]:w-full max-[900px]:max-w-[340px] max-[900px]:shadow-[-16px_0_40px_rgba(0,0,0,0.14)]">
      <div className="flex h-[46px] shrink-0 items-center gap-1.5 border-b border-border pr-2 pl-3.5">
        <div className="flex-1" />
        <Button
          variant="ghost"
          size="sm"
          className="ai-threads"
          title="Past threads"
          aria-pressed={historyOpen}
          onClick={toggleHistory}
        >
          <History />
        </Button>
        {!readOnly && (
          <Button
            variant="ghost"
            size="sm"
            className="ai-new-thread"
            title="New chat"
            onClick={newChat}
          >
            <Plus />
          </Button>
        )}
        <Button variant="ghost" size="sm" title="Close (⌘J)" onClick={onClose}>
          <X />
        </Button>
      </div>

      {historyOpen && (
        <>
          <div
            className="fixed inset-0 z-30"
            onClick={() => setHistoryOpen(false)}
          />
          {/* Beside the panel where the two fit — the list needs its 280 to the
              left of the panel's 340 — and over it where they do not, as a
              screen the panel pushes to and comes back from. */}
          <div className="ai-thread-list absolute top-0 right-full bottom-0 z-40 flex w-[280px] animate-in flex-col border-x border-border bg-card shadow-[-16px_0_40px_rgba(0,0,0,0.14)] duration-200 ease-out fade-in-0 slide-in-from-right-6 max-[620px]:inset-0 max-[620px]:w-auto max-[620px]:border-x-0 max-[620px]:shadow-none">
            <div className="flex h-[46px] shrink-0 items-center gap-1 border-b border-border pr-2 pl-3.5 max-[620px]:pl-1">
              {/* Only where the list is covering the panel: sitting beside it,
                  there is nothing behind to go back to. */}
              <Button
                variant="ghost"
                size="icon-sm"
                className="hidden max-[620px]:inline-flex"
                aria-label="Back to chat"
                title="Back to chat"
                onClick={() => setHistoryOpen(false)}
              >
                <ChevronLeft />
              </Button>
              <span className="text-sm font-semibold tracking-tight">
                Threads
              </span>
              <div className="flex-1" />
              <Button
                variant="ghost"
                size="sm"
                title="Close"
                className="max-[620px]:hidden"
                onClick={() => setHistoryOpen(false)}
              >
                <X />
              </Button>
            </div>
            <div className="ai-thread-items flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto p-2">
              {threads.length === 0 ? (
                <p className="px-2 py-3 text-[11.5px] leading-relaxed text-muted-foreground">
                  No past threads yet.
                </p>
              ) : (
                threads.map((t) => (
                  <button
                    key={t.id}
                    className="group relative flex w-full flex-col gap-0.5 rounded-lg px-2.5 py-2 text-left transition-colors hover:bg-muted"
                    onClick={() => openThread(t)}
                  >
                    <span className="w-full truncate pr-6 text-[12px] font-medium">
                      {t.title}
                    </span>
                    <span className="text-[10.5px] text-muted-foreground">
                      {new Date(t.updatedAt).toLocaleString([], {
                        month: "short",
                        day: "numeric",
                        hour: "numeric",
                        minute: "2-digit",
                      })}
                    </span>
                    {!readOnly && (
                    <span
                      role="button"
                      aria-label="Delete thread"
                      title="Delete thread"
                      className="absolute top-1/2 right-1.5 grid size-6 -translate-y-1/2 place-items-center rounded-md text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100 hover:bg-black/10 hover:text-red-600"
                      onClick={(e) => {
                        e.stopPropagation();
                        deleteThread(t.id);
                      }}
                    >
                      <Trash2 className="size-3.5" />
                    </span>
                    )}
                  </button>
                ))
              )}
            </div>
          </div>
        </>
      )}

      {chatsReady && (
        <ChatSession
          key={sessionThread}
          projectId={projectId}
          threadId={sessionThread}
          info={mergedInfo}
          model={model}
          onModelChange={selectModel}
        />
      )}
    </aside>
  );
}

/** Animates the composer's chip area to its content height, so every growth —
 * the first attachment opening the row, a full row wrapping a new one open —
 * raises the box smoothly instead of snapping. While growing, the box is
 * shorter than its content and clips it; settled, it relaxes so chip hover
 * cards and moment pickers can pop outside. Shrinks (a removed chip, the
 * emptied row collapsing) animate too — their content already fits, so they
 * never need the clip. */
function ChipsReveal({ open, children }: { open: boolean; children: ReactNode }) {
  const outer = useRef<HTMLDivElement>(null);
  const inner = useRef<HTMLDivElement>(null);
  const [h, setH] = useState(0);
  useEffect(() => {
    const el = inner.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setH(el.offsetHeight));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const target = open ? h : 0;
  useLayoutEffect(() => {
    const el = outer.current;
    if (el && el.offsetHeight < target) el.style.overflow = "hidden";
  }, [target]);
  return (
    <div
      ref={outer}
      className="transition-[height] duration-300 ease-[cubic-bezier(0.32,0.72,0,1)]"
      style={{ height: target }}
      onTransitionEnd={(e) => {
        if (e.propertyName === "height" && outer.current) outer.current.style.overflow = "";
      }}
    >
      <div ref={inner}>{children}</div>
    </div>
  );
}

/** One chat with the agent. Remounts per active thread; its messages and
 * provider session are restored from the saved thread on open. */
function ChatSession({
  projectId,
  threadId,
  info,
  model,
  onModelChange,
}: {
  projectId: string;
  threadId: string;
  info: ModelsInfo | null;
  model: string;
  onModelChange: (id: string) => void;
}) {
  const [input, setInput] = useState("");
  const composerRef = useRef<HTMLTextAreaElement>(null);
  const caps = useCutCaps();
  const readOnly = useEditor((s) => s.readOnly);
  // Live dictation → drops the finished transcript into the composer, appended
  // after whatever the user had already typed.
  const mic = useMicTranscription((text) =>
    setInput((prev) => (prev.trim() ? `${prev.trim()} ${text}` : text)),
  );
  // When dictation ends the composer remounts; put the caret back at the end
  // so Enter (confirm) → Enter (send) chains without a click.
  const micWasActive = useRef(false);
  useEffect(() => {
    if (micWasActive.current && mic.state === "idle") {
      const el = composerRef.current;
      if (el) {
        el.focus();
        el.setSelectionRange(el.value.length, el.value.length);
      }
    }
    micWasActive.current = mic.state !== "idle";
  }, [mic.state]);
  const [attachments, setAttachments] = useState<AssetRef[]>([]);
  const candidates = useRefCandidates();
  // Any OS file drag over the window hints the composer as a drop target;
  // hovering it (dropActive below) strengthens the ring and shows the label.
  const fileDropHint = useEditor((s) => s.dropActive !== null);
  // A resumed run can pin the scene card with no chat messages behind it — the
  // empty-state intro/suggestions must yield to it so the two don't stack. The
  // card shows in the thread that asked (unowned = pre-chatId runs, shown
  // anywhere), so only that thread suppresses the intro.
  const hasSceneRun = useGenScene(
    (s) =>
      !!s.run &&
      s.run.projectId === projectId &&
      (!s.run.chatId || s.run.chatId === threadId),
  );
  // OS files handed to the composer — dropped on it or pasted into it —
  // attach as references (media files import into the project on the way,
  // chat-owned so they stay off the Media panel; text files ride as-is).
  const attachFiles = (files: File[]) => {
    void refsFromDroppedFiles(projectId, files, { chatId: threadId }).then(
      (refs) => setAttachments((prev) => refs.reduce(addRefOnce, prev)),
    );
  };
  const {
    active: dropActive,
    attachTarget,
    targetProps,
  } = useAssetDrop(
    (ref) => setAttachments((prev) => addRefOnce(prev, ref)),
    attachFiles,
  );
  // A transient warning in the folder tab above the composer — the same slot
  // the credits tab uses — for refusals like the frame capacity below.
  const [notice, setNotice] = useState<string | null>(null);
  const noticeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const showNotice = (msg: string) => {
    setNotice(msg);
    if (noticeTimer.current) clearTimeout(noticeTimer.current);
    noticeTimer.current = setTimeout(() => setNotice(null), 5000);
  };
  useEffect(
    () => () => {
      if (noticeTimer.current) clearTimeout(noticeTimer.current);
    },
    [],
  );
  // The timeline's "Add video frame to chat" lands its pinned ref here; the
  // registration follows the composer box's lifetime (absent on read-only
  // shares, where there is no composer to receive it). `incoming` marks a
  // frame still in flight, opening the chip row ahead of the landing.
  // Grabbed frames stop at the render models' reference capacity, read from
  // the registry, so every attached frame actually rides a render.
  const composerBoxRef = useRef<HTMLDivElement>(null);
  const [incoming, setIncoming] = useState(false);
  const attachmentsRef = useRef(attachments);
  useEffect(() => {
    attachmentsRef.current = attachments;
  }, [attachments]);
  useEffect(() => {
    const el = composerBoxRef.current;
    if (!el) return;
    const isFrame = (r: AssetRef) => r.scope === "file" && r.kind === "image";
    const cap = videoModel("omni").maxReferenceImages;
    return registerChatIntake({
      el,
      add: (ref) => setAttachments((p) => upsertRef(p, ref)),
      expect: setIncoming,
      acceptFrame: () => {
        if (attachmentsRef.current.filter(isFrame).length < cap) return true;
        showNotice(
          `Renders read up to ${cap} reference frames — remove one to add another.`,
        );
        return false;
      },
      notice: showNotice,
    });
  }, [readOnly]);
  const sessionKeyRef = useRef<string | null>(null);
  // Resume from the saved thread when this id exists in history.
  const [initialThread] = useState<ChatThread | undefined>(() =>
    typeof window === "undefined"
      ? undefined
      : readThreads(projectId).find((t) => t.id === threadId),
  );
  const providerSessions = useRef<Record<string, string>>({
    ...(initialThread?.sessions ?? {}),
  });
  // Seed the pi session registry from the stored thread before any turn runs.
  useEffect(() => {
    if (initialThread?.pi) hydratePiSession(threadId, initialThread.pi);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- initialThread is the mount-time snapshot
  }, [threadId]);
  const modelRef = useRef(model);
  modelRef.current = model;

  // Gemini turns run their editor tools inside the transport loop (no engine
  // bridge); this flags them so onToolCall doesn't execute those calls again.
  const clientToolsRef = useRef(false);
  const transport = useMemo<ChatTransport<UIMessage>>(() => {
    const engine = new DefaultChatTransport<UIMessage>({
      // The engine origin is discovered asynchronously; await it per request
      // (not at mount) so an early send still targets the local engine rather
      // than the hosted origin, where the Cut APIs 404. engineReady memoizes,
      // so only the first request pays for discovery. CLI chat always runs on
      // this Mac's engine — even for a cloud project — so the URL comes from
      // localBackend (read after the origin resolves), which carries the
      // account scope the engine requires on every data route.
      prepareSendMessagesRequest: async ({ messages }) => {
        await engineReady();
        return {
          api: localBackend.url("/api/cut/ai/chat"),
          body: {
            messages,
            model: modelRef.current,
            context: buildAiContext(),
            providerSession: providerSessions.current[provider(modelRef.current)],
          },
        };
      },
    });
    return {
      // Claude/Codex chat through the local engine; Gemini goes straight from
      // the page to Donkey's hosted inference with the user's session.
      sendMessages: async (options) => {
        if (provider(modelRef.current) === "gemini") {
          clientToolsRef.current = true;
          return streamCutChat({
            threadId,
            model: modelRef.current,
            messages: options.messages,
            abortSignal: options.abortSignal,
            deps: productionDeps(),
          });
        }
        clientToolsRef.current = false;
        return engine.sendMessages(options);
      },
      reconnectToStream: (options) => engine.reconnectToStream(options),
    };
  }, [threadId]);

  const { messages, sendMessage, stop, status, error, clearError } = useChat({
    id: threadId,
    messages: initialThread && settleInterruptedTools(initialThread.messages),
    transport,
    onData: (part) => {
      if (part.type === "data-session") {
        const d = part.data as {
          sessionKey?: string;
          providerSession?: string;
        };
        if (d.sessionKey) sessionKeyRef.current = d.sessionKey;
        if (d.providerSession)
          providerSessions.current[provider(modelRef.current)] =
            d.providerSession;
      }
    },
    onToolCall: ({ toolCall }) => {
      // Gemini turns already executed the tool in the transport loop; their
      // tool chunks are display-only.
      if (clientToolsRef.current) return;
      // Execute on the editor store, then hand the result back to the
      // server-side bridge (which is holding the provider's tool call open).
      void (async () => {
        const post = (payload: Record<string, unknown>) =>
          localBackend.fetch("/api/cut/ai/tool-result", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              sessionKey: sessionKeyRef.current,
              toolCallId: toolCall.toolCallId,
              ...payload,
            }),
          });
        try {
          const output = await runAiTool(
            toolCall.toolName,
            (toolCall.input ?? {}) as Record<string, unknown>,
          );
          await post({ output });
        } catch (err) {
          await post({
            errorText: err instanceof Error ? err.message : String(err),
          });
        }
      })();
    },
  });

  // The scene card is part of the conversation, not a pinned banner: it
  // renders right under the turn that planned the scene (the newest
  // generate_scene call), so later queries and answers read below it in
  // order. A run with no such turn in this thread (a resumed or re-homed
  // one) falls back to the end of the list.
  const sceneAnchorId = useMemo(
    () =>
      [...messages].reverse().find((m) =>
        m.parts.some((part) => {
          const name =
            part.type === "dynamic-tool"
              ? (part as { toolName?: string }).toolName
              : part.type.startsWith("tool-")
                ? part.type.slice(5)
                : undefined;
          return name === "generate_scene";
        }),
      )?.id,
    [messages],
  );

  const busy = status === "submitted" || status === "streaming";

  // While this thread is open its tools tag created assets with it, so
  // deleting the thread later can clean them up.
  useEffect(() => {
    setActiveChatThread(threadId);
    return () => setActiveChatThread(null);
  }, [threadId]);

  // Pin this thread as the owner while its turn streams. Deliberately no
  // unmount cleanup: a thread switch mid-turn unmounts this session while the
  // stream (and its tool calls) keeps running — the pin must outlive the
  // panel so that work still files under the thread that asked.
  useEffect(() => {
    if (busy) beginChatTurn(threadId);
    else endChatTurn(threadId);
  }, [busy, threadId]);

  // Coalesce every edit the assistant makes in one turn into a single undo
  // step, so ⌘Z reverts the whole turn rather than one tool call at a time.
  useEffect(() => {
    if (!busy) return;
    useEditor.getState().beginHistoryBatch();
    return () => useEditor.getState().endHistoryBatch();
  }, [busy]);

  // Keep the thread saved (so it shows up in the Threads panel) as it grows.
  // A save rereads, re-slims, and rewrites the project's whole stored history —
  // synchronous main-thread work that scales with everything the chats have
  // ever produced — and a streaming turn replaces `messages` every chunk, so
  // saving on each change ground the editor down as transcripts grew. The
  // newest snapshot parks in a ref and lands at most once per THREAD_SAVE_MS;
  // turn end, thread switch, and pagehide flush it, so nothing is lost.
  const pendingThread = useRef<ChatThread | null>(null);
  const saveTimer = useRef<number | null>(null);
  const saveThreadNow = useCallback(() => {
    const thread = pendingThread.current;
    if (!thread) return;
    pendingThread.current = null;
    if (saveTimer.current !== null) {
      window.clearTimeout(saveTimer.current);
      saveTimer.current = null;
    }
    const rest = readThreads(projectId).filter((t) => t.id !== thread.id);
    writeThreads(projectId, [thread, ...rest]);
    // Cloud projects mirror the thread server-side (debounced while it streams).
    queueCloudThreadSave(projectId, slimForStorage([thread])[0]);
  }, [projectId]);
  useEffect(() => {
    if (messages.length === 0) return;
    const firstUser = messages.find((m) => m.role === "user");
    const title =
      firstUser?.parts
        .map((p) => (p.type === "text" ? p.text : ""))
        .join("")
        .trim()
        .slice(0, 80) || "New chat";
    pendingThread.current = {
      id: threadId,
      title,
      updatedAt: Date.now(),
      messages,
      sessions: { ...providerSessions.current },
      pi: readPiSession(threadId),
    };
    if (saveTimer.current === null) {
      saveTimer.current = window.setTimeout(() => {
        saveTimer.current = null;
        saveThreadNow();
      }, THREAD_SAVE_MS);
    }
  }, [messages, threadId, projectId, saveThreadNow]);

  // Land the final transcript locally and on the server as soon as the turn
  // settles instead of waiting out the save throttle.
  useEffect(() => {
    if (busy) return;
    saveThreadNow();
    flushCloudThreadSaves();
  }, [busy, saveThreadNow]);

  // A thread switch unmounts this session mid-throttle; the page going away
  // skips unmounts entirely. Both flush the parked snapshot.
  useEffect(() => {
    const onPageHide = () => {
      saveThreadNow();
      flushCloudThreadSaves(true);
    };
    window.addEventListener("pagehide", onPageHide);
    return () => {
      window.removeEventListener("pagehide", onPageHide);
      saveThreadNow();
      flushCloudThreadSaves();
    };
  }, [saveThreadNow]);

  // Stay glued to the newest message while the user sits at the bottom;
  // scrolling up releases the glue until they return. The ResizeObserver
  // catches growth the messages effect misses — streamed text reflowing and
  // media cards getting their height after load — so answers never end up
  // clipped at the bottom.
  const scrollRef = useRef<HTMLDivElement>(null);
  const pinnedRef = useRef(true);
  const onMessagesScroll = () => {
    const el = scrollRef.current;
    if (el)
      pinnedRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
  };
  useEffect(() => {
    const content = scrollRef.current?.firstElementChild;
    if (!content) return;
    const ro = new ResizeObserver(() => {
      const el = scrollRef.current;
      if (el && pinnedRef.current) el.scrollTop = el.scrollHeight;
    });
    ro.observe(content);
    return () => ro.disconnect();
  }, []);
  useEffect(() => {
    const el = scrollRef.current;
    if (el && pinnedRef.current) el.scrollTop = el.scrollHeight;
  }, [messages, busy]);

  const [sendError, setSendError] = useState<string | null>(null);
  // Messages submitted while a turn runs wait here and dispatch one at a time
  // as turns settle. Waiting rows persist per thread, so a reload or a trip
  // to another project brings them back — paused, so nothing fires on its
  // own until the user resumes.
  const [initialQueue] = useState(() => readStoredQueue(projectId, threadId));
  const [queue, setQueue] = useState<QueuedMessage[]>(initialQueue);
  const [queuePaused, setQueuePaused] = useState(initialQueue.length > 0);
  const [queueEditing, setQueueEditing] = useState<string | null>(null);
  const drainedRef = useRef(false);
  // Height of the floating stack above the composer (warning tabs + queue
  // tray); the messages pad their bottom by it so the newest message can
  // scroll out from behind the stack.
  const overlayRef = useRef<HTMLDivElement>(null);
  const [overlayH, setOverlayH] = useState(0);
  useEffect(() => {
    const el = overlayRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setOverlayH(el.offsetHeight));
    ro.observe(el);
    return () => ro.disconnect();
  }, [readOnly]);
  const currentAvailable = info
    ? info.providers[provider(model)]?.available !== false
    : true;
  const unavailableMessage = (): string => {
    const p = provider(model);
    if (p === "gemini") return "Sign in to your Donkey account to chat with Gemini.";
    const note = info?.providers[p]?.note?.trim();
    return note ? `${PROVIDER_LABEL[p]}: ${note}` : `${PROVIDER_LABEL[p]} isn't available.`;
  };
  const send = (text: string) => {
    // Inline @mentions attach their assets alongside the dropped chips. The
    // message keeps the raw tokens — they render as interactive chips and the
    // model reads the handle↔asset mapping from <attached_assets>.
    const body = text.trim();
    const { refs: all } = collectRefs(body, attachments, candidates);
    if (!body && all.length === 0) return;
    // An unavailable provider surfaces as an error in the thread at send time
    // rather than a standing footer note: say why nothing sent, then stop.
    if (!currentAvailable) {
      setSendError(unavailableMessage());
      return;
    }
    if (busy) {
      // A paused queue stays paused: parked rows fire only from the tray's
      // resume button, never as a side effect of submitting something new.
      setQueue((q) => [
        ...q,
        { id: crypto.randomUUID(), text: body, attachments: all, status: "queued" },
      ]);
      setInput("");
      setAttachments([]);
      pinnedRef.current = true;
      return;
    }
    clearError();
    setSendError(null);
    // A direct send starts a new turn; a row still marked running belongs to
    // the settled one — sweep it, or cross it out under a frozen view.
    setQueue((q) =>
      q.flatMap((m) =>
        m.status !== "running"
          ? [m]
          : queueEditing === null
            ? []
            : [{ ...m, status: "done" as const }],
      ),
    );
    pinnedRef.current = true;
    void sendMessage({
      text: body,
      ...(all.length > 0 && { metadata: { attachments: all } }),
    });
    setInput("");
    setAttachments([]);
  };

  // Drain the queue as turns settle. drainedRef keeps it to one dispatch per
  // ready period — the effect re-runs when the queue changes before useChat
  // surfaces the new turn's status. A dispatched row stays in the queue as
  // running until the next dispatch settles it: it leaves the tray, or stays
  // crossed out in place while an open row edit has the view frozen. The edit
  // skips only its own row — the rest keep draining. An unavailable provider
  // holds the drain the same way it stops a direct send; the tray reads as
  // paused until the user switches models or the provider comes back.
  // Defined after the settle-flush effect above, so the finished transcript
  // saves before the next turn starts mutating messages.
  useEffect(() => {
    if (status !== "ready") {
      drainedRef.current = false;
      return;
    }
    if (drainedRef.current || queuePaused || !currentAvailable) return;
    const next = queue.find(
      (m) => m.status === "queued" && m.id !== queueEditing,
    );
    if (!next) return;
    drainedRef.current = true;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- the drain reacts to the chat stream settling; drainedRef caps it at one guarded dispatch per ready period
    setQueue((q) =>
      q.flatMap((m) => {
        if (m.id === next.id) return [{ ...m, status: "running" as const }];
        if (m.status !== "running") return [m];
        return queueEditing === null
          ? []
          : [{ ...m, status: "done" as const }];
      }),
    );
    setSendError(null);
    pinnedRef.current = true;
    // A restored row's attachments may point at assets deleted since it was
    // parked (or at file blobs that died with the last page); dropping the
    // dead refs keeps the message from claiming media it can't deliver.
    const live = next.attachments.filter(
      (a) =>
        !a.url?.startsWith("blob:") &&
        (a.scope !== "project" ||
          useEditor.getState().assets.some((x) => x.id === a.id)),
    );
    void sendMessage({
      text: next.text,
      ...(live.length > 0 && { metadata: { attachments: live } }),
    });
  }, [status, queue, queuePaused, queueEditing, currentAvailable, sendMessage]);

  // Mirror the waiting rows to storage as they change; an empty queue clears
  // its slot.
  useEffect(() => {
    if (readOnly) return;
    const waiting = queue.filter((m) => m.status === "queued");
    if (waiting.length === 0)
      localStorage.removeItem(queueKey(projectId, threadId));
    else
      localStorage.setItem(
        queueKey(projectId, threadId),
        JSON.stringify(waiting),
      );
  }, [queue, projectId, threadId, readOnly]);

  // An errored turn holds the queue for review — the drain only fires on
  // 'ready', and the tray reads the error as paused. Resuming clears the
  // error, which settles status back to ready and releases the drain. An
  // unavailable provider holds it the same way.
  const queueHeld = queuePaused || status === "error" || !currentAvailable;
  // The tray shows only while a row is waiting; settled running rows linger
  // in the array until the next dispatch sweeps them, and alone they are
  // nothing to show.
  const trayVisible = queue.some((m) => m.status === "queued");

  // The saved model's provider may be uninstalled — its group is hidden from
  // the picker, so fall back to the first installed provider rather than sit on
  // a selection the user can no longer see or change.
  useEffect(() => {
    if (!info || info.providers[provider(model)]?.installed !== false) return;
    const fallback = AI_MODELS.find(
      (m) => !m.hidden && info.providers[provider(m.id)]?.installed !== false,
    );
    if (fallback && fallback.id !== model) onModelChange(fallback.id);
  }, [info, model, onModelChange]);
  const outOfCredits = useOutOfCredits((s) => s.out);
  useCreditsRecheck();

  return (
    <div
      ref={attachTarget}
      {...targetProps}
      className="relative flex min-h-0 flex-1 flex-col"
    >
      <ScrollArea
        className="min-h-0 flex-1"
        // Scene cards and the pinning logic reach the scrolling element by
        // class and ref, so both ride the viewport.
        viewportClassName="ai-messages"
        viewportRef={scrollRef}
        onViewportScroll={onMessagesScroll}
        contentClassName="px-3.5 py-3"
      >
        {/* Single wrapper so the ResizeObserver sees all content growth. The
            bottom padding matches the floating stack over the composer, so
            the newest message can scroll out from behind it. */}
        <div style={{ paddingBottom: overlayH }}>
          {messages.length === 0 && !hasSceneRun && (
            <div className="flex flex-col gap-3 pt-6">
              <p className="text-[12.5px] leading-relaxed text-muted-foreground">
                I can see your whole project — clips, titles, subtitles, publish
                metadata — and edit it for you. Select something and tell me
                what to change, or ask anything about the cut.
              </p>
              <div className="flex flex-wrap gap-1.5">
                {SUGGESTIONS.map((sug) => (
                  <button
                    key={sug}
                    className="ai-suggestion rounded-full border border-border px-2.5 py-1 text-[11.5px] text-muted-foreground transition-colors hover:border-input hover:text-foreground"
                    onClick={() => send(sug)}
                  >
                    {sug}
                  </button>
                ))}
              </div>
            </div>
          )}
          {messages.map((m) => (
            <Fragment key={m.id}>
              <MessageView message={m} />
              {m.id === sceneAnchorId && <SceneCard threadId={threadId} />}
            </Fragment>
          ))}
          {sceneAnchorId === undefined && <SceneCard threadId={threadId} />}
          <ThreadRenders threadId={threadId} />
          {busy && (
            <div className="ai-busy mt-1 flex items-center gap-1.5 text-[11.5px] text-muted-foreground">
              <CircleDashed className="size-3 animate-spin" /> Working…{" "}
              <LiveElapsed />
            </div>
          )}
          {(error || (sendError && !currentAvailable)) && (
            <div className="ai-error mt-2 flex items-start gap-2 rounded-lg bg-red-50 px-2.5 py-2 text-[11.5px] leading-relaxed text-red-700">
              <TriangleAlert className="mt-0.5 size-3.5 shrink-0" />
              <span>
                {error ? (
                  <HostedErrorText error={error.message} link={false} />
                ) : (
                  sendError
                )}
              </span>
            </div>
          )}
        </div>
      </ScrollArea>

      {!readOnly && (
      <div className="shrink-0 px-2.5 pb-2.5">
        <div className="relative">
          {/* The stack above the composer — warning tabs first, then the
              queue tray — floats over the messages, which scroll behind it;
              the messages pad their bottom by its measured height so the
              newest message still lands in view. Its bottom few pixels slide
              under the composer box, which paints over them, so the bottom
              piece meets the border even where the box's corner radius
              curves away. */}
          <div
            ref={overlayRef}
            className="pointer-events-none absolute inset-x-0 bottom-full z-10 -mb-1 flex flex-col"
          >
            {outOfCredits && (
              <a
                className={cn(
                  "ai-credits-tab pointer-events-auto mx-1.5 flex items-center gap-1.5 rounded-t-lg border border-b-0 border-amber-500/30 bg-amber-50 px-3 pt-1.5 pb-2.5 text-[11px] text-amber-800",
                  // With the tray below, the tab tucks under it the same way
                  // the stack tucks under the composer.
                  trayVisible && "-mb-1",
                )}
                href={creditsUrl()}
                target="_blank"
                rel="noreferrer"
              >
                <TriangleAlert className="size-3 shrink-0" />
                <span>
                  No credits left —{" "}
                  <span className="font-medium underline">reload credits</span>
                </span>
              </a>
            )}
            {!outOfCredits && notice && (
              // The credits tab's folder shape, borrowed for transient
              // refusals; the credits warning outranks it when both apply.
              <div
                className={cn(
                  "ai-notice-tab pointer-events-auto mx-1.5 flex items-center gap-1.5 rounded-t-lg border border-b-0 border-amber-500/30 bg-amber-50 px-3 pt-1.5 pb-2.5 text-[11px] text-amber-800",
                  trayVisible && "-mb-1",
                )}
              >
                <TriangleAlert className="size-3 shrink-0" />
                <span>{notice}</span>
              </div>
            )}
            {trayVisible && (
              <div className="pointer-events-auto">
            <ComposerQueue
              items={queue}
              paused={queueHeld}
              busy={busy}
              editingId={queueEditing}
              onEditingChange={(id) => {
                setQueueEditing(id);
                // Closing the freeze sweeps out the crossed-out rows it kept
                // around for display.
                if (id === null)
                  setQueue((q) => q.filter((m) => m.status === "queued"));
              }}
              onCommitEdit={(id, text) =>
                setQueue((q) =>
                  q.map((m) =>
                    m.id === id ? { ...m, text: text.trim() || m.text } : m,
                  ),
                )
              }
              onRemove={(id) => setQueue((q) => q.filter((m) => m.id !== id))}
              onReorder={(from, to) =>
                setQueue((q) => {
                  const next = [...q];
                  const [grabbed] = next.splice(from, 1);
                  next.splice(to, 0, grabbed);
                  return next;
                })
              }
              onTogglePaused={() => {
                if (status === "error") {
                  clearError();
                  setQueuePaused(false);
                } else {
                  setQueuePaused((p) => !p);
                }
              }}
            />
              </div>
            )}
          </div>
          <div
            ref={composerBoxRef}
            className={cn(
              // z above the floating stack so the box paints over its tucked
              // bottom edge.
              "relative z-10 rounded-xl border bg-background transition-colors",
              dropActive
                ? "border-[#0a84ff] ring-2 ring-[#0a84ff]/30"
                : fileDropHint
                  ? "border-[#0a84ff]/45 ring-2 ring-[#0a84ff]/15"
                  : "border-input focus-within:border-ring",
            )}
          >
            {dropActive && (
              <div className="px-3 pt-2 text-[11.5px] font-medium text-[#0a84ff]">
                Drop to attach
              </div>
            )}
            {mic.state === "idle" ? (
              <>
                <ChipsReveal open={attachments.length > 0 || incoming}>
                  <RefChips
                    refs={attachments}
                    onRemove={(ref) =>
                      setAttachments((p) => p.filter((x) => !sameRef(x, ref)))
                    }
                    onUpdate={(ref) =>
                      setAttachments((p) => p.map((x) => (sameRef(x, ref) ? ref : x)))
                    }
                    className="px-2.5 pt-2.5"
                    // Chip-sized spacer riding the chip row while a frame is
                    // in flight: it claims the arriving chip's exact slot —
                    // opening the row, or wrapping a fresh one when the row
                    // is full — so the space is ready before the landing.
                    trailing={incoming ? <div className="size-14" /> : undefined}
                  />
                </ChipsReveal>
                <MentionTextarea
                  className="ai-input max-h-56 w-full resize-none overflow-y-auto bg-transparent px-3 pt-2 text-[12.5px] leading-relaxed outline-none placeholder:text-muted-foreground/70"
                  rows={5}
                  autoGrow
                  placeholder="Ask about your video, or tell me what to change… @ references media"
                  value={input}
                  onChange={setInput}
                  candidates={candidates}
                  submitKey="enter"
                  menuSide="top"
                  inputRef={composerRef}
                  onSubmit={() => send(input)}
                  attachedRefs={attachments}
                  onUpsertRef={(ref) => setAttachments((p) => upsertRef(p, ref))}
                  onPasteFiles={attachFiles}
                  onRemoveLastRef={() => setAttachments((p) => p.slice(0, -1))}
                />
                <div className="flex items-center gap-1 px-1.5 pb-1.5">
                  <ModelSelector
                    info={info}
                    model={model}
                    onSelect={onModelChange}
                  />
                  <div className="flex-1" />
                  {caps.liveMic && (
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      className="ai-mic text-muted-foreground"
                      title="Dictate"
                      disabled={busy}
                      onClick={() => void mic.start()}
                    >
                      <Mic className="size-3.5" />
                    </Button>
                  )}
                  {busy ? (
                    <Button
                      variant="outline"
                      size="sm"
                      className="ai-stop"
                      title="Stop"
                      onClick={() => {
                        // stop() settles to 'ready', which the drain reads as
                        // a clean finish — park the queue here so it stays put
                        // for review. An empty queue has nothing to park, and
                        // pausing it anyway would leave a stale flag.
                        if (queue.some((m) => m.status === "queued"))
                          setQueuePaused(true);
                        void stop();
                      }}
                    >
                      <Square className="size-3" />
                    </Button>
                  ) : (
                    <Button
                      size="sm"
                      className="ai-send"
                      title="Send (Enter)"
                      disabled={!input.trim() && attachments.length === 0}
                      onClick={() => send(input)}
                    >
                      <ArrowUp className="size-3.5" />
                    </Button>
                  )}
                </div>
              </>
            ) : (
              <DictationBody text={input} mic={mic} />
            )}
          </div>
        </div>
        {mic.error && (
          <p className="mt-1.5 px-1 text-[10.5px] leading-relaxed text-amber-700">
            {mic.error}
          </p>
        )}
      </div>
      )}
    </div>
  );
}

/** Asset card inside a sent message — click to jump back to the original
 * asset, double-click to expand, drag onto the timeline, "…" menu for more
 * actions. */
function MessageAssetCard({ asset }: { asset: AssetRef }) {
  // The reveal waits out the double-click window, so expanding doesn't also
  // jump the side panel to the asset.
  const clickTimer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(clickTimer.current), []);
  return (
    <div
      className={cn(
        "ai-msg-asset group relative",
        // Audio gets the wide timeline-pill treatment; the row still wraps
        // inside the message's max width.
        asset.kind === "audio" ? "w-44 max-w-full" : "w-16",
      )}
    >
      <button
        className="flex w-full flex-col gap-1 text-left"
        title={`${asset.name} — click to show · drag to the timeline`}
        draggable
        onDragStart={(e) => {
          // Project assets keep the timeline-placement payload; the ref rides
          // along either way (chat, creators), from the card's own data so it
          // survives the asset leaving the project.
          if (asset.scope === "project") setAssetDragData(e, asset.id);
          setRefDragData(e, asset);
        }}
        onClick={() => {
          window.clearTimeout(clickTimer.current);
          clickTimer.current = window.setTimeout(() => revealRef(asset), 250);
        }}
        onDoubleClick={() => {
          window.clearTimeout(clickTimer.current);
          useLightbox.getState().open(lightboxItemFromRef(asset));
        }}
      >
        <RefThumb
          item={asset}
          className={cn(
            asset.kind === "audio" ? "h-12 w-full" : "size-16",
            "transition-colors group-hover:border-input",
          )}
        />
        <span className="w-full truncate text-[10px] text-muted-foreground">
          {asset.name}
        </span>
      </button>
      <DropdownMenu>
        <DropdownMenuTrigger
          render={
            <button
              aria-label="Asset options"
              className="absolute top-1 right-1 grid size-5 place-items-center rounded-md bg-black/55 text-white opacity-0 transition-opacity group-hover:opacity-100 hover:bg-black/75"
            />
          }
        >
          <Ellipsis className="size-3" />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="w-40">
          <DropdownMenuItem
            onClick={() =>
              useLightbox.getState().open(lightboxItemFromRef(asset))
            }
          >
            <Maximize2 /> Expand
          </DropdownMenuItem>
          <DropdownMenuItem
            onClick={() => window.open(asset.url, "_blank", "noopener")}
          >
            <ExternalLink /> Open file
          </DropdownMenuItem>
          {asset.scope === "project" && (
            <DropdownMenuItem
              onClick={() => {
                const s = useEditor.getState();
                const full = s.assets.find((a) => a.id === asset.id);
                if (!full || !s.projectId) return;
                void saveAssetToLibrary(s.projectId, full).catch(() => {
                  // Library write failed; nothing to roll back.
                });
              }}
            >
              <FolderPlus /> Add to Library
            </DropdownMenuItem>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}

/** User-message text with resolved `@` mentions rendered as interactive token
 * chips. Tokens resolve against the message's own attachments first (they hold
 * what was meant at send time), then the live candidates. */
function MentionedText({
  text,
  attachments,
}: {
  text: string;
  attachments: AssetRef[];
}) {
  const candidates = useRefCandidates();
  const parts = useMemo(
    () => splitMentions(text, [...attachments, ...candidates]),
    [text, attachments, candidates],
  );
  return (
    <>
      {parts.map((p, i) =>
        typeof p === "string" ? (
          <span key={i}>{p}</span>
        ) : (
          <RefTokenChip key={i} item={p} onDark />
        ),
      )}
    </>
  );
}

/** Copy-to-clipboard affordance revealed on message hover. */
function MessageCopy({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  if (!text) return null;
  return (
    <button
      aria-label="Copy message"
      title="Copy"
      className={cn(
        "ai-msg-copy",
        cardIconButton,
        "opacity-0 group-hover:opacity-100",
      )}
      onClick={() => {
        void navigator.clipboard.writeText(text).then(() => {
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        });
      }}
    >
      {copied ? (
        <Check className="size-3.5 text-emerald-600" />
      ) : (
        <Copy className="size-3.5" />
      )}
    </button>
  );
}

/** Memoized per message: a streaming turn replaces `messages` every chunk,
 * and only the growing message should re-render — settled ones hold whole
 * asset-card subtrees. */
// How long each tool call ran, tracked across this session's renders (keyed by
// tool-call id). We stamp the start the first time a call renders while still
// running and the end when it settles, so the chip can show its duration.
const toolTimes = new Map<
  string,
  { start: number; end?: number; sawRunning: boolean }
>();
// The map lives for the page; long sessions evict the oldest settled entries
// (their chips have already captured the duration they show).
const TOOL_TIMES_CAP = 500;
function toolDuration(id: string | undefined, settled: boolean): string | null {
  if (!id) return null;
  let t = toolTimes.get(id);
  if (!t) {
    if (toolTimes.size >= TOOL_TIMES_CAP) {
      for (const key of toolTimes.keys()) {
        if (toolTimes.size < TOOL_TIMES_CAP) break;
        if (toolTimes.get(key)?.end !== undefined) toolTimes.delete(key);
      }
    }
    t = { start: Date.now(), sawRunning: !settled };
    toolTimes.set(id, t);
  }
  if (settled && t.end === undefined) t.end = Date.now();
  // Null for a call first seen already-done (e.g. loaded on reload): its real
  // start is unknown, so a "0:00" would lie.
  return t.sawRunning && t.end !== undefined
    ? formatDuration(t.end - t.start)
    : null;
}

/** Live clock on a still-running tool chip. Its own component so the ticking
 * re-render stays inside the chip — MessageView is memoized and only
 * re-renders on stream chunks, which stop arriving while a tool runs. */
function RunningToolClock({ start }: { start: number }) {
  const elapsed = useElapsed(start);
  return elapsed ? (
    <span className="ml-auto tabular-nums text-[10px]">{elapsed}</span>
  ) : null;
}

// Markdown for assistant chat text — the shared base plus a compact inline
// `code` style. Defined once so the answer body and the reasoning body render
// identically.
const chatMarkdownComponents: Components = {
  ...baseMarkdownComponents,
  code: (p) => (
    <code
      className="rounded bg-muted px-1 py-px font-mono text-[11px] break-words whitespace-pre-wrap"
      {...p}
    />
  ),
  pre: (p) => (
    <pre
      className="my-1.5 max-w-full overflow-x-auto rounded-md bg-muted/70 p-2 text-[11px] leading-relaxed whitespace-pre-wrap break-words"
      {...p}
    />
  ),
};

// The model's replayed context wraps bookkeeping in tag blocks (<tools_ran>,
// <editor_state>, …), and a reply sometimes mimics one verbatim. The blocks are
// input-side scaffolding, so any that reach assistant text get stripped wherever
// that text leaves the transcript: render, copy, and storage. Three passes:
// closed blocks anywhere; then a still-open tag swallows through end-of-string
// only when it starts a line — a mimicked block always does, and this covers a
// block arriving across stream deltas without eating a mid-sentence mention
// like `<editor_state>`; then stray closers.
const TAG_NAMES = "tools_ran|turn_ledger|editor_state|attached_assets";
const CLOSED_BLOCK = new RegExp(`<(${TAG_NAMES})>[^]*?</\\1>`, "g");
const OPEN_TAIL = new RegExp(`(?:^|\\n)[ \\t]*<(?:${TAG_NAMES})>[^]*$`);
const STRAY_CLOSE = new RegExp(`</(?:${TAG_NAMES})>`, "g");

export function sanitizeAssistantText(text: string): string {
  if (!text.includes("<")) return text;
  return text.replace(CLOSED_BLOCK, "").replace(OPEN_TAIL, "").replace(STRAY_CLOSE, "").trim();
}

// Some models verbalize their chain-of-thought inline in the reply, tagging
// each block with a `NN_thought` marker (e.g. `96_thought The user wants…`).
// It lands in a plain text part; splitting on the marker lets the reasoning
// collapse behind a disclosure instead of flooding the conversation.
const THOUGHT_MARKER = /(?<!\w)\d+_thought\b[ \t]*/g;
type TextSegment = { kind: "text" | "thought"; text: string };

function splitThoughtSegments(text: string): TextSegment[] {
  const markers = [...text.matchAll(THOUGHT_MARKER)];
  if (markers.length === 0) return [{ kind: "text", text }];
  const segments: TextSegment[] = [];
  const firstAt = markers[0].index ?? 0;
  const lead = text.slice(0, firstAt);
  if (lead.trim()) segments.push({ kind: "text", text: lead });
  // Each marker opens a thought that runs to the next marker (or the end):
  // the reasoning is the whole tail of the part, and any real answer arrives
  // as its own later, unmarked part.
  markers.forEach((m, idx) => {
    const start = (m.index ?? 0) + m[0].length;
    const end = idx + 1 < markers.length ? (markers[idx + 1].index ?? text.length) : text.length;
    const body = text.slice(start, end);
    if (body.trim()) segments.push({ kind: "thought", text: body });
  });
  return segments;
}

/** A pulled post's own words, clamped to a few lines when the source ran
 * long, with a chevron to unfold the full text in place. */
function SourceQuote({ text }: { text: string }) {
  const [expanded, setExpanded] = useState(false);
  const [clamped, setClamped] = useState(false);
  const bodyRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = bodyRef.current;
    if (!el) return;
    setClamped(el.scrollHeight > el.clientHeight + 1);
  }, [text]);
  return (
    <blockquote className="border-l-2 border-border pl-3 text-[12.5px] leading-relaxed text-muted-foreground">
      <div
        ref={bodyRef}
        className={cn(
          "break-words whitespace-pre-wrap",
          !expanded && "line-clamp-4",
        )}
      >
        {text}
      </div>
      {(clamped || expanded) && (
        <button
          type="button"
          aria-label={expanded ? "Collapse source text" : "Expand source text"}
          onClick={() => setExpanded((v) => !v)}
          className="mt-1 flex cursor-pointer items-center rounded text-muted-foreground/70 transition-colors hover:text-foreground"
        >
          <ChevronDown
            className={cn("size-3.5 transition-transform", expanded && "rotate-180")}
          />
        </button>
      )}
    </blockquote>
  );
}

type ToolPartView = {
  type: string;
  toolName?: string;
  toolCallId?: string;
  state: string;
  input?: unknown;
  output?: unknown;
  errorText?: string;
};

const isToolPartType = (t: string) => t.startsWith("tool-") || t === "dynamic-tool";
const toolPartName = (p: ToolPartView) => p.toolName ?? p.type.slice(5);

/** One tool chip. `parts` holds a single call, or a run of settled same-name,
 * same-outcome calls collapsed into one counted chip — nine add_title runs
 * read as one row. The disclosure shows every call's payload. */
function ToolChipGroup({ parts }: { parts: ToolPartView[] }) {
  const p = parts[parts.length - 1];
  const name = toolPartName(p);
  const failed = p.state === "output-error";
  const done = p.state === "output-available";
  const single = parts.length === 1;
  const took = single ? toolDuration(p.toolCallId, done || failed) : null;
  // A call still running shows a live clock from its observed start (settled
  // chips show `took`; a call first seen already-done shows neither — its
  // real start is unknown).
  const runningSince =
    single && !done && !failed && p.toolCallId
      ? (toolTimes.get(p.toolCallId)?.start ?? null)
      : null;
  const payload = single
    ? { input: p.input, output: p.output, error: p.errorText }
    : parts.map((c) => ({ input: c.input, output: c.output, error: c.errorText }));
  return (
    <details className="ai-tool group max-w-full">
      <summary
        className={cn(
          "flex cursor-pointer list-none items-center gap-1.5 rounded-md border border-border px-2 py-1 text-[11px] text-muted-foreground transition-colors select-none hover:bg-muted/60 [&::-webkit-details-marker]:hidden",
          failed && "border-red-200 text-red-700",
        )}
      >
        <Wrench className="size-3 shrink-0" />
        <span className="font-mono">{name}</span>
        {!single && (
          <span className="tabular-nums text-[10px]">×{parts.length}</span>
        )}
        {done && <Check className="size-3 text-emerald-600" />}
        {failed && <TriangleAlert className="size-3" />}
        {!done && !failed && <CircleDashed className="size-3 animate-spin" />}
        {took && (
          <span className="ml-auto tabular-nums text-[10px]">{took}</span>
        )}
        {runningSince != null && <RunningToolClock start={runningSince} />}
      </summary>
      <pre className="mt-1 max-h-40 overflow-auto rounded-md bg-muted/70 p-2 font-mono text-[10px] leading-relaxed whitespace-pre-wrap">
        {JSON.stringify(payload, null, 2)}
      </pre>
    </details>
  );
}

/** A run of 3+ settled tool chips folded behind one summary row. Opening it
 * reveals the individual chips, each still expandable to its payload. */
function ToolRunGroup({ groups }: { groups: ToolPartView[][] }) {
  const calls = groups.reduce((n, g) => n + g.length, 0);
  const failed = groups.some((g) => g.some((p) => p.state === "output-error"));
  return (
    <details className="ai-tool-run group/run max-w-full">
      <summary
        className={cn(
          "flex cursor-pointer list-none items-center gap-1.5 rounded-md border border-border px-2 py-1 text-[11px] text-muted-foreground transition-colors select-none hover:bg-muted/60 [&::-webkit-details-marker]:hidden",
          failed && "border-red-200 text-red-700",
        )}
      >
        <Wrench className="size-3 shrink-0" />
        <span>
          {calls} tool call{calls === 1 ? "" : "s"}
        </span>
        {failed ? (
          <TriangleAlert className="size-3" />
        ) : (
          <Check className="size-3 text-emerald-600" />
        )}
        <ChevronDown className="ml-auto size-3 transition-transform group-open/run:rotate-180" />
      </summary>
      <div className="mt-1.5 flex flex-col gap-1.5 border-l border-border pl-2">
        {groups.map((parts, i) => (
          <ToolChipGroup key={i} parts={parts} />
        ))}
      </div>
    </details>
  );
}

/** A collapsed disclosure for a reasoning block, styled like the tool row. */
function ThoughtBlock({ text }: { text: string }) {
  return (
    <details className="ai-thought group max-w-full">
      <summary className="flex cursor-pointer list-none items-center gap-1.5 rounded-md border border-border px-2 py-1 text-[11px] text-muted-foreground transition-colors select-none hover:bg-muted/60 [&::-webkit-details-marker]:hidden">
        <Brain className="size-3 shrink-0" />
        <span>Thought</span>
        <ChevronDown className="ml-auto size-3 transition-transform group-open:rotate-180" />
      </summary>
      <div className="ai-md mt-1 max-w-full px-2 text-[12px] leading-relaxed text-muted-foreground">
        <Markdown components={chatMarkdownComponents}>{text}</Markdown>
      </div>
    </details>
  );
}

const MessageView = memo(function MessageView({
  message,
}: {
  message: UIMessage;
}) {
  if (message.role === "user") {
    const text = message.parts
      .map((p) => (p.type === "text" ? p.text : ""))
      .join("");
    // normalizeRef also reads attachments saved by older threads (pre-ref shape).
    const attachments = (
      (message.metadata as { attachments?: unknown[] } | undefined)
        ?.attachments ?? []
    )
      .map(normalizeRef)
      .filter((r): r is AssetRef => r !== null);
    return (
      <div className="ai-msg-user group mb-3 flex flex-col items-end gap-1">
        {attachments.length > 0 && (
          <div className="flex max-w-[85%] flex-wrap justify-end gap-1.5">
            {attachments.map((a) => (
              <MessageAssetCard key={`${a.scope}:${a.id}`} asset={a} />
            ))}
          </div>
        )}
        {text && (
          <div className="max-w-[85%] rounded-2xl rounded-br-md bg-neutral-900 px-3 py-2 text-[12.5px] leading-relaxed break-words whitespace-pre-wrap text-white">
            <MentionedText text={text} attachments={attachments} />
          </div>
        )}
        <MessageCopy text={text} />
      </div>
    );
  }
  const text = sanitizeAssistantText(
    message.parts.map((p) => (p.type === "text" ? p.text : "")).join(""),
  );
  // Media the turn produced, gathered from every finished tool call. It renders
  // as one left-to-right row after the chips — the way the mock presents a set
  // of generated stills — instead of one card stacked under each tool.
  const toolOutputs = message.parts
    .filter((part) => part.type.startsWith("tool-") || part.type === "dynamic-tool")
    .map((part) => part as unknown as { state: string; output?: unknown })
    .filter((p) => p.state === "output-available")
    .map((p) => p.output);
  // The source's own words for anything the turn pulled off the web (a tweet's
  // body, a video's title/description). It renders as a quote beside the media
  // — straight from the tool output, so the model never has to retype it.
  const sourceTexts = toolOutputs
    .map((o) => (o && typeof o === "object" ? (o as { sourceText?: unknown }).sourceText : undefined))
    .filter((t): t is string => typeof t === "string" && t.trim().length > 0);
  // Consecutive settled calls of the same tool with the same outcome collapse
  // into one counted chip; running calls always stand alone.
  type Block =
    | { kind: "part"; index: number; part: (typeof message.parts)[number] }
    | { kind: "tools"; index: number; parts: ToolPartView[] };
  const blocks: Block[] = [];
  message.parts.forEach((part, index) => {
    if (!isToolPartType(part.type)) {
      blocks.push({ kind: "part", index, part });
      return;
    }
    const p = part as unknown as ToolPartView;
    const settled = p.state === "output-available" || p.state === "output-error";
    const last = blocks[blocks.length - 1];
    if (
      settled &&
      last?.kind === "tools" &&
      last.parts[0].state === p.state &&
      toolPartName(last.parts[0]) === toolPartName(p)
    ) {
      last.parts.push(p);
      return;
    }
    blocks.push({ kind: "tools", index, parts: [p] });
  });
  // A run of 3+ consecutive settled chips folds behind one "N tool calls" row;
  // a still-running call stays outside the fold so its spinner remains visible.
  type RenderBlock = Block | { kind: "toolrun"; index: number; groups: ToolPartView[][] };
  const renderBlocks: RenderBlock[] = [];
  let run: Extract<Block, { kind: "tools" }>[] = [];
  const flushRun = () => {
    if (run.length >= 3) {
      renderBlocks.push({
        kind: "toolrun",
        index: run[0].index,
        groups: run.map((b) => b.parts),
      });
    } else {
      renderBlocks.push(...run);
    }
    run = [];
  };
  for (const block of blocks) {
    const settled =
      block.kind === "tools" &&
      block.parts.every(
        (p) => p.state === "output-available" || p.state === "output-error",
      );
    if (settled && block.kind === "tools") {
      run.push(block);
      continue;
    }
    flushRun();
    renderBlocks.push(block);
  }
  flushRun();
  return (
    <div className="ai-msg-assistant group mb-3 flex min-w-0 flex-col gap-1.5">
      {renderBlocks.map((block) => {
        if (block.kind === "toolrun") {
          return <ToolRunGroup key={block.index} groups={block.groups} />;
        }
        if (block.kind === "tools") {
          return <ToolChipGroup key={block.index} parts={block.parts} />;
        }
        const part = block.part;
        if (part.type === "text") {
          return (
            <Fragment key={block.index}>
              {splitThoughtSegments(sanitizeAssistantText(part.text)).map((seg, j) =>
                seg.kind === "thought" ? (
                  <ThoughtBlock key={j} text={seg.text} />
                ) : (
                  <div
                    key={j}
                    className="ai-md min-w-0 max-w-full overflow-hidden text-[12.5px] leading-relaxed break-words"
                  >
                    <Markdown components={chatMarkdownComponents}>
                      {seg.text}
                    </Markdown>
                  </div>
                ),
              )}
            </Fragment>
          );
        }
        return null;
      })}
      {/* The imported post's own text, quoted above its media so the two read
          as one thing — the tweet body, or the video's title and description. */}
      {sourceTexts.map((t, i) => (
        <SourceQuote key={`src-${i}`} text={t} />
      ))}
      {/* Everything the turn generated, in one left-to-right row (images and
          clips flow and wrap; audio and documents take their own line). It
          stays in the chat until the user drags it out or files it away. */}
      {toolOutputs.length > 0 && (
        <div className="flex flex-wrap items-start gap-1.5">
          {toolOutputs.map((output, i) => (
            <ToolOutputAssets key={i} output={output} />
          ))}
        </div>
      )}
      <MessageCopy text={text} />
    </div>
  );
});

/** Ambient proof this thread's renders are still working: chat-launched video
 * jobs run in the background long after the tool call returns, so the bottom
 * of the conversation shows a live count and clock until every render settles
 * — the cards up-thread flip to their result, but this line is what says
 * "something is still happening" without scrolling. */
function ThreadRenders({ threadId }: { threadId: string }) {
  const jobs = useGenerate((s) => s.jobs);
  const records = useEditor((s) => s.renders);
  const live = jobs.filter(
    (j) =>
      j.kind === "video" && j.status === "running" && j.chatId === threadId,
  );
  // Renders another machine is still working on: doc-mirrored records with no
  // local job. The TTL keeps a record whose job died from spinning forever;
  // a mount-time clock is enough for that check.
  const [now] = useState(() => Date.now());
  const liveIds = new Set(jobs.map((j) => j.id));
  const remote = records.filter(
    (r) =>
      r.chatId === threadId &&
      r.status === "running" &&
      !liveIds.has(r.id) &&
      now - r.startedAt < RECORD_RUNNING_TTL_MS,
  );
  const running = [...live, ...remote];
  const oldest = running.length
    ? Math.min(...running.map((j) => j.startedAt))
    : null;
  const elapsed = useElapsed(oldest);
  if (running.length === 0) return null;
  return (
    <div className="ai-renders mt-1 flex items-center gap-1.5 text-[11.5px] text-muted-foreground">
      <CircleDashed className="size-3 animate-spin" />
      Rendering {running.length === 1
        ? "a video"
        : `${running.length} videos`}…{" "}
      {elapsed && <span className="tabular-nums">{elapsed}</span>}
    </div>
  );
}

function ModelSelector({
  info,
  model,
  onSelect,
}: {
  info: ModelsInfo | null;
  model: string;
  onSelect: (id: string) => void;
}) {
  const [favs, setFavs] = useState<string[]>(() => {
    if (typeof window === "undefined") return [];
    try {
      return JSON.parse(localStorage.getItem(FAVS_KEY) ?? "[]") as string[];
    } catch {
      return [];
    }
  });
  const showTest =
    typeof window !== "undefined" &&
    localStorage.getItem("cut-ai-test") === "1";
  const models = AI_MODELS.filter((m) => !m.hidden || showTest);
  const groups = [
    "claude",
    "codex",
    "gemini",
    ...(showTest ? ["test"] : []),
  ]
    .map((p) => ({
      provider: p,
      models: models.filter((m) => m.provider === p),
      // CLI providers list only once the engine has confirmed the CLI is
      // installed — until the probe answers there is no evidence the group
      // exists on this Mac. Gemini is hosted, so it needs no confirmation.
      installed:
        p === "gemini"
          ? info?.providers[p]?.installed !== false
          : info?.providers[p]?.installed === true,
    }))
    // The picker lists every confirmed provider and lets any of them be
    // picked; any other problem (signed out, etc.) surfaces as a chat error
    // when the user sends.
    .filter((group) => group.models.length > 0 && group.installed);
  const flat = groups.flatMap((group) => group.models);
  const currentLabel = models.find((m) => m.id === model)?.label ?? model;

  const toggleFav = (id: string) => {
    const next = favs.includes(id)
      ? favs.filter((f) => f !== id)
      : [...favs, id];
    setFavs(next);
    localStorage.setItem(FAVS_KEY, JSON.stringify(next));
  };

  return (
    <DropdownMenu>
      <DropdownMenuTrigger className="ai-model-trigger flex items-center gap-1 rounded-md px-1.5 py-1 text-[11px] font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground">
        <Sparkles className="size-3" />
        {currentLabel}
        <ChevronDown className="size-3" />
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="start"
        className="ai-model-menu w-60"
        onKeyDown={(e) => {
          const n = Number(e.key);
          if (n >= 1 && n <= flat.length) onSelect(flat[n - 1].id);
        }}
      >
        {groups.map((group, gi) =>
          group.models.length === 0 ? null : (
            <DropdownMenuGroup key={group.provider}>
              {gi > 0 && <DropdownMenuSeparator />}
              <DropdownMenuLabel className="flex items-center gap-1.5 text-[10.5px] tracking-wider text-muted-foreground uppercase">
                <Sparkles className="size-3" /> {PROVIDER_LABEL[group.provider]}
              </DropdownMenuLabel>
              {group.models.map((m) => (
                <DropdownMenuItem
                  key={m.id}
                  className="ai-model-item gap-2"
                  onClick={() => onSelect(m.id)}
                >
                  <span className="flex-1 text-[12px]">{m.label}</span>
                  {model === m.id && (
                    <Check className="size-3.5 text-[#0a84ff]" />
                  )}
                  <button
                    className="rounded p-0.5 hover:bg-muted"
                    title={favs.includes(m.id) ? "Unfavorite" : "Favorite"}
                    onClick={(e) => {
                      e.stopPropagation();
                      e.preventDefault();
                      toggleFav(m.id);
                    }}
                  >
                    <Star
                      className={cn(
                        "size-3",
                        favs.includes(m.id)
                          ? "fill-amber-400 text-amber-400"
                          : "text-muted-foreground/50",
                      )}
                    />
                  </button>
                  <span className="w-3 text-right font-mono text-[10px] text-muted-foreground/60">
                    {flat.indexOf(m) + 1}
                  </span>
                </DropdownMenuItem>
              ))}
            </DropdownMenuGroup>
          ),
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
