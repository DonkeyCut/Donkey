import {
  Body,
  Container,
  Head,
  Hr,
  Html,
  Link,
  Preview,
  Tailwind,
  Text,
  pixelBasedPreset,
} from "react-email";

import { CommunityPs } from "./_components/CommunityPs";
import { DonkeyMark } from "./_components/DonkeyMark";

// The one email a new account gets: a personal note from David. Sent by
// src/lib/email/send-welcome.ts; preview with `npm run email:dev`. The credit
// amount arrives as a prop so src/lib/onboarding/sequence.ts stays its single
// source. This module stays pure — the react-email preview server bundles it
// on its own, so everything it needs comes in as props and asset/link URLs are
// absolute.

type WelcomeEmailProps = {
  name: string;
  // Null when the account received no signup credits.
  credits: string | null;
  unsubscribeUrl: string;
};

export default function WelcomeEmail({
  name,
  credits,
  unsubscribeUrl,
}: WelcomeEmailProps) {
  return (
    <Html>
      <Head />
      <Preview>
        I built Donkey Cut because I wanted a video editor that was simple and
        open source.
      </Preview>
      <Tailwind config={{ presets: [pixelBasedPreset] }}>
        <Body className="bg-white font-sans text-[#0F0E0D]">
          <Container className="mx-auto max-w-[520px] px-6 py-12">
            <DonkeyMark />
            <Text className="text-[15px] leading-relaxed">Hey {name},</Text>
            <Text className="text-[15px] leading-relaxed">
              Thanks for signing up.
            </Text>
            <Text className="text-[15px] leading-relaxed">
              I&apos;m David, and I built Donkey Cut because I wanted a video
              editor that was simple and open source.
            </Text>
            <Text className="text-[15px] leading-relaxed">
              My favorite feature is Edit with Chat. Instead of clicking
              through menus, I can just tell the editor what I want, and it
              does it for me.
            </Text>
            <Text className="text-[15px] leading-relaxed">
              The editor will always have a free version, and the entire
              project is open source.
            </Text>
            {credits !== null && (
              <Text className="text-[15px] leading-relaxed">
                I also added ${credits} in AI credits to your account so you
                can try AI Chat or generate videos, images, audio, and more.
              </Text>
            )}
            <Text className="text-[15px] leading-relaxed">
              If you enjoy using Donkey Cut, I&apos;d really appreciate a ⭐ on
              GitHub. If you have questions, feedback, or just want to say hi,
              join the Discord. I&apos;m there every day.
            </Text>
            <Text className="text-[15px] leading-relaxed">
              This email goes straight to my personal inbox, so feel free to
              reply anytime. I read every email.
            </Text>
            <Text className="text-[15px] leading-relaxed">
              Thanks again for giving Donkey Cut a try.
            </Text>
            <Text className="text-[15px] leading-relaxed">
              Have a great day!
            </Text>
            <Text className="text-[15px] leading-relaxed">David</Text>
            <CommunityPs />
            <Hr className="mt-6 border-[#0F0E0D]/15" />
            <Text className="text-[12px] leading-relaxed text-[#0F0E0D]/60">
              You&apos;re receiving this because you created a Donkey Cut
              account.{" "}
              <Link
                href={unsubscribeUrl}
                className="text-[#0F0E0D]/60 underline"
              >
                Unsubscribe
              </Link>{" "}
              from product emails.
            </Text>
          </Container>
        </Body>
      </Tailwind>
    </Html>
  );
}

WelcomeEmail.PreviewProps = {
  name: "Ada",
  credits: "3",
  unsubscribeUrl: "https://donkeycut.com/unsubscribe?token=preview",
} satisfies WelcomeEmailProps;
