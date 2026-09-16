import { createRoot } from "react-dom/client";
import { Timeline } from "@/cut/components/Timeline";
import { useEditor } from "@/cut/lib/store";
import { copyTimelineSelection, pasteCutPayload, payloadFromHtml } from "@/cut/lib/cutClipboard";
import { EMPTY_LIBRARY } from "@/cut/lib/assetRef";
import { previewAt } from "@/cut/lib/playhead";

window.__cutDev = { useEditor };
window.addEventListener("keydown", (event) => {
  const s = useEditor.getState();
  if ((event.metaKey || event.ctrlKey) && event.key === "c") {
    if (copyTimelineSelection()) event.preventDefault();
  } else if (event.key === "s") s.splitAtPlayhead();
});
window.addEventListener("paste", (event) => {
  const s = useEditor.getState();
  const payload = payloadFromHtml(event.clipboardData?.getData("text/html"));
  event.preventDefault();
  if (payload && s.projectId) void pasteCutPayload(payload, { projectId: s.projectId, at: previewAt(), library: EMPTY_LIBRARY });
  else s.paste();
});
createRoot(document.getElementById("root")!).render(
  <div className="flex h-full flex-col justify-end"><Timeline /></div>
);
