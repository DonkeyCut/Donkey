import { createRoot } from "react-dom/client";
import { EmbeddedSignInFallback } from "../../src/cut/components/EmbeddedSignInFallback";

createRoot(document.getElementById("session")!).render(<EmbeddedSignInFallback />);
