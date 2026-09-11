"use client";

import "@mdxeditor/editor/style.css";

import {
  BlockTypeSelect,
  BoldItalicUnderlineToggles,
  ButtonWithTooltip,
  CodeToggle,
  CreateLink,
  DialogButton,
  DiffSourceToggleWrapper,
  GenericJsxEditor,
  InsertCodeBlock,
  InsertImage,
  InsertTable,
  InsertThematicBreak,
  ListsToggle,
  MDXEditor,
  Separator,
  UndoRedo,
  codeBlockPlugin,
  codeMirrorPlugin,
  diffSourcePlugin,
  headingsPlugin,
  imagePlugin,
  insertJsx$,
  jsxPlugin,
  linkDialogPlugin,
  linkPlugin,
  listsPlugin,
  markdownShortcutPlugin,
  quotePlugin,
  rootEditor$,
  tablePlugin,
  thematicBreakPlugin,
  toolbarPlugin,
  useCellValue,
  useLexicalNodeRemove,
  useMdastNodeUpdater,
  usePublisher,
  type JsxComponentDescriptor,
  type JsxEditorProps,
} from "@mdxeditor/editor";
import { COMMAND_PRIORITY_HIGH, PASTE_COMMAND } from "lexical";
import { Megaphone, MessageSquareQuote, Video } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { BlogVideo } from "@/app/cut/blog/_components/BlogVideo";
import { BLOG_ARTICLE_CLASS } from "@/app/cut/blog/_components/mdxComponents";
import type { BlogEditorProps } from "@/app/su/blog/[id]/BlogEditor";
import { parseVideoUrl } from "@/lib/blog/video";

// The article editor. The body is MDX: markdown with three named blocks the
// public page knows (Video, BlogCTA, InlineCTA). Images land at the cursor
// from a drop, a paste, or the toolbar, and each upload comes back as the
// public address, so the saved markdown is a plain image line.

const CODE_LANGUAGES = {
  "": "Plain text",
  bash: "Shell",
  css: "CSS",
  html: "HTML",
  js: "JavaScript",
  json: "JSON",
  ts: "TypeScript",
  tsx: "TSX",
};

const stringAttr = (node: JsxEditorProps["mdastNode"], name: string): string => {
  const found = node.attributes.find((attr) => attr.type === "mdxJsxAttribute" && attr.name === name);
  return found && typeof found.value === "string" ? found.value : "";
};

// <Video src="…" /> in the editor: the same player the article shows, with
// the address editable underneath.
function VideoJsxEditor({ mdastNode }: JsxEditorProps) {
  const update = useMdastNodeUpdater();
  const remove = useLexicalNodeRemove();
  const src = stringAttr(mdastNode, "src");
  const title = stringAttr(mdastNode, "title");
  const known = parseVideoUrl(src) !== null;
  const set = (name: string, value: string) => {
    const rest = mdastNode.attributes.filter((attr) => !(attr.type === "mdxJsxAttribute" && attr.name === name));
    update({
      attributes: value ? [...rest, { type: "mdxJsxAttribute", name, value }] : rest,
    });
  };
  return (
    <div contentEditable={false} className="my-4 space-y-2">
      {src ? <BlogVideo src={src} title={title || undefined} /> : null}
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <label className="flex min-w-0 flex-1 items-center gap-2">
          <span className="shrink-0 text-muted-foreground">Video</span>
          <input
            value={src}
            placeholder="YouTube, Vimeo or .mp4 address"
            className="min-w-0 flex-1 rounded-md border px-2 py-1"
            onChange={(event) => set("src", event.target.value.trim())}
          />
        </label>
        <label className="flex items-center gap-2">
          <span className="text-muted-foreground">Title</span>
          <input
            value={title}
            className="w-40 rounded-md border px-2 py-1"
            onChange={(event) => set("title", event.target.value)}
          />
        </label>
        <button type="button" className="text-muted-foreground hover:text-destructive" onClick={remove}>
          Remove
        </button>
      </div>
      {src && !known ? (
        <p className="text-xs text-destructive">Not a video address the page can play; it renders as a link.</p>
      ) : null}
    </div>
  );
}

const JSX_DESCRIPTORS: JsxComponentDescriptor[] = [
  {
    name: "Video",
    kind: "flow",
    props: [
      { name: "src", type: "string" },
      { name: "title", type: "string" },
    ],
    hasChildren: false,
    Editor: VideoJsxEditor,
  },
  {
    name: "BlogCTA",
    kind: "flow",
    props: [
      { name: "variant", type: "string" },
      { name: "title", type: "string" },
      { name: "description", type: "string" },
      { name: "buttonText", type: "string" },
      { name: "buttonHref", type: "string" },
    ],
    hasChildren: false,
    Editor: GenericJsxEditor,
  },
  {
    name: "InlineCTA",
    kind: "flow",
    props: [],
    hasChildren: false,
    Editor: GenericJsxEditor,
  },
];

// A bare video address pasted on its own becomes a Video block where the
// cursor is. The check is the address's host or file extension, nothing more.
function VideoPaste() {
  const editor = useCellValue(rootEditor$);
  const insertJsx = usePublisher(insertJsx$);
  useEffect(() => {
    if (!editor) return;
    return editor.registerCommand(
      PASTE_COMMAND,
      (event) => {
        if (!(event instanceof ClipboardEvent) || !event.clipboardData) return false;
        if (event.clipboardData.files.length > 0) return false;
        const text = event.clipboardData.getData("text/plain").trim();
        if (!text || /\s/.test(text) || !parseVideoUrl(text)) return false;
        event.preventDefault();
        insertJsx({ name: "Video", kind: "flow", props: { src: text } });
        return true;
      },
      COMMAND_PRIORITY_HIGH,
    );
  }, [editor, insertJsx]);
  return null;
}

function InsertVideo() {
  const insertJsx = usePublisher(insertJsx$);
  return (
    <DialogButton
      tooltipTitle="Insert video"
      submitButtonTitle="Insert"
      dialogInputPlaceholder="YouTube, Vimeo or .mp4 address"
      buttonContent={<Video className="size-5" />}
      onSubmit={(value) => {
        const src = value.trim();
        if (src) insertJsx({ name: "Video", kind: "flow", props: { src } });
      }}
    />
  );
}

function InsertCtas() {
  const insertJsx = usePublisher(insertJsx$);
  return (
    <>
      <ButtonWithTooltip
        title="Insert call to action banner"
        onClick={() => insertJsx({ name: "BlogCTA", kind: "flow", props: { variant: "banner" } })}
      >
        <Megaphone className="size-5" />
      </ButtonWithTooltip>
      <ButtonWithTooltip
        title="Insert inline call to action"
        onClick={() => insertJsx({ name: "InlineCTA", kind: "flow", props: {} })}
      >
        <MessageSquareQuote className="size-5" />
      </ButtonWithTooltip>
    </>
  );
}

export default function BlogEditorInner({ markdown, diffMarkdown, onChange, uploadImage }: BlogEditorProps) {
  const [parseError, setParseError] = useState<string | null>(null);

  const plugins = useMemo(
    () => [
      headingsPlugin({ allowedHeadingLevels: [2, 3, 4] }),
      listsPlugin(),
      quotePlugin(),
      thematicBreakPlugin(),
      linkPlugin(),
      linkDialogPlugin(),
      tablePlugin(),
      imagePlugin({ imageUploadHandler: uploadImage }),
      codeBlockPlugin({ defaultCodeBlockLanguage: "" }),
      codeMirrorPlugin({ codeBlockLanguages: CODE_LANGUAGES }),
      jsxPlugin({ jsxComponentDescriptors: JSX_DESCRIPTORS }),
      markdownShortcutPlugin(),
      diffSourcePlugin({ viewMode: "rich-text", diffMarkdown }),
      toolbarPlugin({
        toolbarContents: () => (
          <DiffSourceToggleWrapper>
            <VideoPaste />
            <UndoRedo />
            <Separator />
            <BoldItalicUnderlineToggles />
            <CodeToggle />
            <Separator />
            <BlockTypeSelect />
            <Separator />
            <ListsToggle />
            <Separator />
            <CreateLink />
            <InsertImage />
            <InsertVideo />
            <Separator />
            <InsertTable />
            <InsertThematicBreak />
            <InsertCodeBlock />
            <Separator />
            <InsertCtas />
          </DiffSourceToggleWrapper>
        ),
      }),
    ],
    // The diff baseline is read when the plugin mounts; a later save updates
    // it through the editor's own state.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [uploadImage],
  );

  return (
    <div className="overflow-hidden rounded-xl border bg-white">
      {parseError ? (
        <p role="alert" className="border-b bg-destructive/10 px-4 py-2 text-xs text-destructive">
          The body has markup the editor cannot show. Source mode still edits it. {parseError}
        </p>
      ) : null}
      <MDXEditor
        markdown={markdown}
        onChange={(next, initialNormalize) => {
          if (!initialNormalize) onChange(next);
        }}
        onError={({ error }) => setParseError(error)}
        plugins={plugins}
        contentEditableClassName={`${BLOG_ARTICLE_CLASS} min-h-[60vh] px-6 py-5`}
        placeholder="Write the article…"
      />
    </div>
  );
}
