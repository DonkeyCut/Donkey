import {
  Body,
  Button,
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

// The email behind a credit offer: David added credit to the account, and
// one button claims it. Sent by src/lib/email/send-credits-offered.ts;
// preview with `npm run email:dev`. This module stays pure — the react-email
// preview server bundles it on its own, so everything it needs comes in as
// props and link URLs are absolute.

type CreditsOfferedEmailProps = {
  name: string;
  // The offer, as USD ("$25.00").
  credits: string;
  // How long the credits live once claimed, already worded ("7 days"), or
  // null when they never expire.
  lifetime: string | null;
  claimUrl: string;
  unsubscribeUrl: string;
};

export default function CreditsOfferedEmail({
  name,
  credits,
  lifetime,
  claimUrl,
  unsubscribeUrl,
}: CreditsOfferedEmailProps) {
  return (
    <Html>
      <Head />
      <Preview>{credits} in AI credits is waiting on your Donkey Cut account.</Preview>
      <Tailwind config={{ presets: [pixelBasedPreset] }}>
        <Body className="bg-white font-sans text-[#0F0E0D]">
          <Container className="mx-auto max-w-[520px] px-6 py-12">
            <DonkeyMark />
            <Text className="text-[15px] leading-relaxed">Hey {name},</Text>
            <Text className="text-[15px] leading-relaxed">
              I added {credits} in AI credits to your Donkey Cut account. Click
              below to claim them.
            </Text>
            <Button
              href={claimUrl}
              className="rounded-lg bg-[#0F0E0D] px-6 py-3 text-[15px] font-semibold text-[#F5EFE0]"
            >
              Claim {credits} in credits
            </Button>
            <Text className="text-[15px] leading-relaxed">
              {lifetime !== null
                ? `Once claimed, they are good for ${lifetime}. `
                : ""}
              You can use them for Edit with Chat, or to generate videos,
              images, audio, and voice.
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

CreditsOfferedEmail.PreviewProps = {
  name: "Ada",
  credits: "$25.00",
  lifetime: "7 days",
  claimUrl: "https://donkeycut.com/claim?token=preview",
  unsubscribeUrl: "https://donkeycut.com/unsubscribe?token=preview",
} satisfies CreditsOfferedEmailProps;
