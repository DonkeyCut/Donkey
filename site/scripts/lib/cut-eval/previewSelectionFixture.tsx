import { createRoot } from "react-dom/client";
import { Preview } from "@/cut/components/Preview";
import { useEditor } from "@/cut/lib/store";

window.__cutDev = { useEditor };
createRoot(document.getElementById("root")!).render(<Preview />);
