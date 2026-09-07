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

import { DonkeyMark } from "./_components/DonkeyMark";

// The one notice an account gets before its signup credits expire: a short
// note from David naming what is left and the day it goes. Sent by
// src/lib/email/send-credits-expiring.ts; preview with `npm run email:dev`.
// This module stays pure — the react-email preview server bundles it on its
// own, so everything it needs comes in as props and link URLs are absolute.

type CreditsExpiringEmailProps = {
  name: string;
  // What is left of the grant, as USD ("$2.57").
  credits: string;
  // The day it expires, already worded ("September 14, 2026").
  expiresOn: string;
  editorUrl: string;
  unsubscribeUrl: string;
};

export default function CreditsExpiringEmail({
  name,
  credits,
  expiresOn,
  editorUrl,
  unsubscribeUrl,
}: CreditsExpiringEmailProps) {
  return (
    <Html>
      <Head />
      <Preview>
        The {credits} in AI credits on your Donkey Cut account expires on {expiresOn}.
      </Preview>
      <Tailwind config={{ presets: [pixelBasedPreset] }}>
        <Body className="bg-white font-sans text-[#0F0E0D]">
          <Container className="mx-auto max-w-[520px] px-6 py-12">
            <DonkeyMark />
            <Text className="text-[15px] leading-relaxed">Hey {name},</Text>
            <Text className="text-[15px] leading-relaxed">
              Just a quick heads up: the {credits} in AI credits on your Donkey
              Cut account expires on {expiresOn}. Any unused credits will
              disappear after that.
            </Text>
            <Text className="text-[15px] leading-relaxed">
              You can use them for Edit with Chat, or to generate videos,
              images, audio, and voice.
            </Text>
            <Text className="text-[15px] leading-relaxed">
              <Link href={editorUrl} className="text-[#0F0E0D] underline">
                Open the editor
              </Link>{" "}
              and put them to use 🙂
            </Text>
            <Text className="text-[15px] leading-relaxed">
              If you have any questions, just reply to this email. It goes
              straight to my inbox.
            </Text>
            <Text className="text-[15px] leading-relaxed">David</Text>
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

CreditsExpiringEmail.PreviewProps = {
  name: "Ada",
  credits: "$2.57",
  expiresOn: "September 14, 2026",
  editorUrl: "https://donkeycut.com/app",
  unsubscribeUrl: "https://donkeycut.com/unsubscribe?token=preview",
} satisfies CreditsExpiringEmailProps;
