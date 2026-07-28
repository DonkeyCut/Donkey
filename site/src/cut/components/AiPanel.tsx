"use client";

import { Fragment, memo, useEffect, useMemo, useRef, useState } from "react";
import { useChat } from "@ai-sdk/react";
import { DefaultChatTransport, type ChatTransport, type UIMessage } from "ai";
import {
  ArrowUp,
  Brain,
  Check,
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
import { apiFetch, apiUrl } from "@/cut/lib/backend";
import { useCutCaps } from "@/cut/lib/backend/hooks";
import { buildAiContext } from "@/cut/lib/aiContext";
import { runAiTool } from "@/cut/lib/aiTools";
import { setAssetDragData } from "@/cut/lib/assetDrag";
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
import { streamGeminiChat } from "@/cut/lib/geminiChat";
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
import { DictationBody } from "./MicDictation";
import { RECORD_RUNNING_TTL_MS, ToolOutputAssets } from "./ChatAssets";
import { HostedErrorText } from "./hostedError";
import { useMicTranscription } from "@/cut/lib/micTranscribe";

// Chat attachments are asset refs — anything in the project, the library, or
// the stock catalog. They arrive by drag (media cards, library clips, stock
// tiles, timeline clips, the preview) or as @name mentions in the message.

interface ModelsInfo {
  // `installed` false hides the provider's whole group; a provider that is
  // installed but unavailable (e.g. signed out) still lists with its note.
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
}

const THREAD_LIMIT = 30;

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
  return list.map((t) => ({
    ...t,
    messages: t.messages.map((m) => ({
      ...m,
      parts: m.parts.map((p) => {
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
    }
  }
  writeRawThreads(projectId, slimForStorage(kept));
}

const MODEL_KEY = "cut-ai-model";
const FAVS_KEY = "cut-ai-favs";
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
  const caps = useCutCaps();
  const readOnly = useEditor((s) => s.readOnly);
  const signedIn = useSignedIn();
  const [model, setModel] = useState<string>(() =>
    typeof window === "undefined"
      ? DEFAULT_MODEL
      : (localStorage.getItem(MODEL_KEY) ?? DEFAULT_MODEL),
  );
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
    // The models probe asks the engine which CLIs are installed; without the
    // localCliChat cap there is no engine to ask (mergedInfo synthesizes the
    // Gemini-only provider set instead).
    if (!caps.localCliChat) return;
    let alive = true;
    void apiFetch("/api/cut/ai/models")
      .then((r) => r.json())
      .then((d: ModelsInfo) => alive && setInfo(d))
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [caps.localCliChat]);

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
    // Without the localCliChat cap (cloud mode) the CLI providers don't exist:
    // their groups hide, and the saved-model fallback effect moves a CLI
    // selection over to Gemini.
    if (!caps.localCliChat) {
      const off = { available: false, note: "", installed: false };
      const providers: ModelsInfo["providers"] = { claude: off, codex: off, test: off, gemini };
      return { providers };
    }
    if (!info) return null;
    return { ...info, providers: { ...info.providers, gemini } };
  }, [info, signedIn, caps.localCliChat]);

  return (
    <aside className="ai-panel relative flex min-h-0 w-[340px] shrink-0 animate-in flex-col border-l border-border bg-card duration-300 ease-out slide-in-from-right-full">
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
          <div className="ai-thread-list absolute top-0 right-full bottom-0 z-40 flex w-[280px] animate-in flex-col border-x border-border bg-card shadow-[-16px_0_40px_rgba(0,0,0,0.14)] duration-200 ease-out fade-in-0 slide-in-from-right-6">
            <div className="flex h-[46px] shrink-0 items-center justify-between border-b border-border pr-2 pl-3.5">
              <span className="text-sm font-semibold tracking-tight">
                Threads
              </span>
              <Button
                variant="ghost"
                size="sm"
                title="Close"
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
  const {
    active: dropActive,
    attachTarget,
    targetProps,
  } = useAssetDrop(
    (ref) => setAttachments((prev) => addRefOnce(prev, ref)),
    // OS files dropped on the chat attach as references (media files import
    // into the project on the way, chat-owned so they stay off the Media
    // panel; text files ride as-is).
    (files) => {
      void refsFromDroppedFiles(projectId, files, { chatId: threadId }).then(
        (refs) => setAttachments((prev) => refs.reduce(addRefOnce, prev)),
      );
    },
  );
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
      // so only the first request pays for discovery. apiUrl (read after the
      // origin resolves) carries the account scope the engine requires on every
      // data route — building the URL by hand here would drop it.
      prepareSendMessagesRequest: async ({ messages }) => {
        await engineReady();
        return {
          api: apiUrl("/api/cut/ai/chat"),
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
          return streamGeminiChat({
            model: modelRef.current,
            messages: options.messages,
            abortSignal: options.abortSignal,
          });
        }
        clientToolsRef.current = false;
        return engine.sendMessages(options);
      },
      reconnectToStream: (options) => engine.reconnectToStream(options),
    };
  }, []);

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
          apiFetch("/api/cut/ai/tool-result", {
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
  useEffect(() => {
    if (messages.length === 0) return;
    const firstUser = messages.find((m) => m.role === "user");
    const title =
      firstUser?.parts
        .map((p) => (p.type === "text" ? p.text : ""))
        .join("")
        .trim()
        .slice(0, 80) || "New chat";
    const thread: ChatThread = {
      id: threadId,
      title,
      updatedAt: Date.now(),
      messages,
      sessions: { ...providerSessions.current },
    };
    const rest = readThreads(projectId).filter((t) => t.id !== threadId);
    writeThreads(projectId, [thread, ...rest]);
    // Cloud projects mirror the thread server-side (debounced while it streams).
    queueCloudThreadSave(projectId, slimForStorage([thread])[0]);
  }, [messages, threadId, projectId]);

  // Land the final transcript on the server as soon as the turn settles
  // instead of waiting out the save debounce.
  useEffect(() => {
    if (!busy) flushCloudThreadSaves();
  }, [busy]);

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
  const send = (text: string) => {
    // Inline @mentions attach their assets alongside the dropped chips. The
    // message keeps the raw tokens — they render as interactive chips and the
    // model reads the handle↔asset mapping from <attached_assets>.
    const body = text.trim();
    const { refs: all } = collectRefs(body, attachments, candidates);
    if ((!body && all.length === 0) || busy) return;
    // An unavailable provider surfaces as an error in the thread at send time
    // rather than a standing footer note: say why nothing sent, then stop.
    if (!currentAvailable) {
      setSendError(unavailableMessage());
      return;
    }
    clearError();
    setSendError(null);
    pinnedRef.current = true;
    void sendMessage({
      text: body,
      ...(all.length > 0 && { metadata: { attachments: all } }),
    });
    setInput("");
    setAttachments([]);
  };

  const currentAvailable = info
    ? info.providers[provider(model)]?.available !== false
    : true;
  const unavailableMessage = (): string => {
    const p = provider(model);
    if (p === "gemini") return "Sign in to your Donkey account to chat with Gemini.";
    const note = info?.providers[p]?.note?.trim();
    return note ? `${PROVIDER_LABEL[p]}: ${note}` : `${PROVIDER_LABEL[p]} isn't available.`;
  };
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
      <div
        ref={scrollRef}
        onScroll={onMessagesScroll}
        className={cn(
          "ai-messages min-h-0 flex-1 overflow-y-auto px-3.5 py-3",
          // The credits tab floats over the bottom of this area; the extra
          // padding lets the last message scroll out from behind it.
          outOfCredits && "pb-9",
        )}
      >
        {/* Single wrapper so the ResizeObserver sees all content growth. */}
        <div>
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
      </div>

      {!readOnly && (
      <div className="shrink-0 px-2.5 pb-2.5">
        <div className="relative">
          {outOfCredits && (
            // Folder tab behind the box: its bottom few pixels slide under the
            // box, which paints over it, so the tab meets the border even where
            // the box's corner radius curves away. Extra bottom padding keeps
            // the text above the overlap. It floats over the messages, which
            // scroll behind it.
            <a
              className="ai-credits-tab absolute inset-x-1.5 bottom-full -mb-1 flex items-center gap-1.5 rounded-t-lg border border-b-0 border-amber-500/30 bg-amber-50 px-3 pt-1.5 pb-2.5 text-[11px] text-amber-800"
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
          <div
            className={cn(
              "relative rounded-xl border bg-background transition-colors",
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
                <RefChips
                  refs={attachments}
                  onRemove={(ref) =>
                    setAttachments((p) => p.filter((x) => !sameRef(x, ref)))
                  }
                  className="px-2.5 pt-2.5"
                />
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
                      onClick={() => void stop()}
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
              <FolderPlus /> Add to library
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
  const text = message.parts
    .map((p) => (p.type === "text" ? p.text : ""))
    .join("");
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
  return (
    <div className="ai-msg-assistant group mb-3 flex min-w-0 flex-col gap-1.5">
      {blocks.map((block) => {
        if (block.kind === "tools") {
          return <ToolChipGroup key={block.index} parts={block.parts} />;
        }
        const part = block.part;
        if (part.type === "text") {
          return (
            <Fragment key={block.index}>
              {splitThoughtSegments(part.text).map((seg, j) =>
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
      installed: info?.providers[p]?.installed !== false,
    }))
    // The picker lists every installed provider and lets any of them be picked;
    // a provider whose CLI isn't installed drops out entirely, and any other
    // problem (signed out, etc.) surfaces as a chat error when the user sends.
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
