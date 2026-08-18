import PrivacyPolicy from "@/app/legal/PrivacyPolicy.mdx";
import { LegalPageShell } from "@/app/legal/LegalPageShell";

export const unstable_instant = { prefetch: "static" };

export default function PrivacyPage() {
  return (
    <LegalPageShell>
      <PrivacyPolicy />
    </LegalPageShell>
  );
}
