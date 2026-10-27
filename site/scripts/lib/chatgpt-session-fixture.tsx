import { createRoot } from "react-dom/client";
import { IntlProvider } from "use-intl";
import editor from "../../src/i18n/messages/en/editor.json";
import { EmbeddedSignInFallback } from "../../src/cut/components/EmbeddedSignInFallback";

// The editor's provider is the page's; the fixture hands the component the
// English editor catalog the same way.
createRoot(document.getElementById("session")!).render(<IntlProvider locale="en" messages={{ editor }}><EmbeddedSignInFallback /></IntlProvider>);
