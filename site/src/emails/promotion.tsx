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
import { Fragment } from "react";

import { DonkeyMark } from "./_components/DonkeyMark";

// A promotion written on su: its paragraphs, an optional button, and the
// opt-out footer. Sent by src/lib/marketing/promotions.ts; preview with
// `npm run email:dev`. This module stays pure — the react-email preview server
// bundles it on its own, so everything it needs comes in as props.

type Block = { kind: "text"; text: string } | { kind: "button" };

type PromotionEmailProps = {
  preview: string;
  blocks: Block[];
  cta: { label: string; url: string } | null;
  unsubscribeUrl: string;
};

function lines(text: string) {
  const parts = text.split("\n");
  return parts.map((line, i) => (
    <Fragment key={i}>
      {i > 0 ? <br /> : null}
      {line}
    </Fragment>
  ));
}

export default function PromotionEmail({
  preview,
  blocks,
  cta,
  unsubscribeUrl,
}: PromotionEmailProps) {
  return (
    <Html>
      <Head />
      <Preview>{preview}</Preview>
      <Tailwind config={{ presets: [pixelBasedPreset] }}>
        <Body className="bg-white font-sans text-[#0F0E0D]">
          <Container className="mx-auto max-w-[520px] px-6 py-12">
            <DonkeyMark />
            {blocks.map((block, i) =>
              block.kind === "button" && cta ? (
                <Button
                  key={i}
                  href={cta.url}
                  className="my-4 rounded-lg bg-[#0F0E0D] px-6 py-3 text-[15px] font-semibold text-[#F5EFE0]"
                >
                  {cta.label}
                </Button>
              ) : block.kind === "text" ? (
                <Text key={i} className="text-[15px] leading-relaxed">
                  {lines(block.text)}
                </Text>
              ) : null,
            )}
            <Hr className="mt-6 border-[#0F0E0D]/15" />
            <Text className="text-[12px] leading-relaxed text-[#0F0E0D]/60">
              You&apos;re receiving this because you created a Donkey Cut
              account.{" "}
              <Link
                href={unsubscribeUrl}
                className="text-[#0F0E0D]/60 underline"
              >
                Unsubscribe
              </Link>
            </Text>
          </Container>
        </Body>
      </Tailwind>
    </Html>
  );
}

PromotionEmail.PreviewProps = {
  preview: "Hey Ada,",
  blocks: [
    { kind: "text", text: "Hey Ada," },
    { kind: "text", text: "Get Pro before October 29 and every month that starts by then includes $100 of AI, 5× the usual $20." },
    { kind: "button" },
    { kind: "text", text: "David" },
  ],
  cta: { label: "Get Pro", url: "https://donkeycut.com/app/settings" },
  unsubscribeUrl: "https://donkeycut.com/unsubscribe?token=preview",
} satisfies PromotionEmailProps;
