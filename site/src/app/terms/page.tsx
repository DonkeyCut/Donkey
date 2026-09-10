import TermsOfService from "@/app/legal/TermsOfService.mdx";
import { LegalPageShell } from "@/app/legal/LegalPageShell";

export const instant = true;

export default function TermsPage() {
  return (
    <LegalPageShell>
      <TermsOfService />
    </LegalPageShell>
  );
}
