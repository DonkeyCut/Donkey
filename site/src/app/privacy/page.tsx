import PrivacyPolicy from "@/app/legal/PrivacyPolicy.mdx";
import { LegalPageShell } from "@/app/legal/LegalPageShell";

export const instant = true;

export default function PrivacyPage() {
  return (
    <LegalPageShell>
      <PrivacyPolicy />
    </LegalPageShell>
  );
}
