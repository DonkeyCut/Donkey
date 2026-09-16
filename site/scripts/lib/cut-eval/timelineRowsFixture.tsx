import { createRoot } from "react-dom/client";
import { Timeline } from "@/cut/components/Timeline";
import { useEditor } from "@/cut/lib/store";
import { setAssetDragData, setElementDragData } from "@/cut/lib/assetDrag";

window.__cutDev = { useEditor };
createRoot(document.getElementById("root")!).render(
  <div className="flex h-full flex-col justify-end">
    <div className="flex h-24 gap-8">
      <div data-source="sticker" draggable onDragStart={(e) => setAssetDragData(e, "sticker-asset")}>Sticker</div>
      <div data-source="shape" draggable onDragStart={(e) => setElementDragData(e, { kind: "shape", shape: "rect" })}>Shape</div>
      <div data-source="effect" draggable onDragStart={(e) => setElementDragData(e, { kind: "effect", effect: "blur" })}>Effect</div>
    </div>
    <Timeline />
  </div>
);
