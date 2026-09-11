"use client";

import dynamic from "next/dynamic";

import { Skeleton } from "@/components/ui/skeleton";

export type BlogEditorProps = {
  markdown: string;
  // What the post last saved as, shown beside the draft in diff mode.
  diffMarkdown: string;
  onChange: (markdown: string) => void;
  uploadImage: (file: File) => Promise<string>;
};

// The editor reaches into the DOM (contentEditable, CodeMirror), so it loads
// in the browser only; the page keeps its shape with a stand-in until then.
const Inner = dynamic(() => import("./BlogEditorInner"), {
  ssr: false,
  loading: () => <Skeleton className="h-[60vh] rounded-xl" />,
});

export function BlogEditor(props: BlogEditorProps) {
  return <Inner {...props} />;
}
