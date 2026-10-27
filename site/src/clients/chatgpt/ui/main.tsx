import { createRoot } from "react-dom/client";
import { WidgetIntl } from "./intl";
import { PreviewApp } from "./PreviewApp";

createRoot(document.getElementById("root")!).render(<WidgetIntl><PreviewApp /></WidgetIntl>);
