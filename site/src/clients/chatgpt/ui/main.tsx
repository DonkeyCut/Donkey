import { createRoot } from "react-dom/client";
import { markClassicScrollbars } from "@/lib/scrollbars";
import { WidgetIntl } from "./intl";
import { PreviewApp } from "./PreviewApp";

markClassicScrollbars(document);

createRoot(document.getElementById("root")!).render(<WidgetIntl><PreviewApp /></WidgetIntl>);
