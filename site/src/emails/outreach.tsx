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
import { Fragment } from "react";

import { CommunityPs } from "./_components/CommunityPs";
import { DonkeyMark } from "./_components/DonkeyMark";

// The shell every outreach note is written into: the mark, the operator's text
// as paragraphs, the community P.S., and the unsubscribe footer. The words
// themselves come from a template in src/lib/marketing/templates/ or straight
// from the send dialog, already filled for this recipient. Preview with
// `npm run email:dev`. This module stays pure — the react-email preview server
// bundles it on its own, so everything it needs comes in as props and
// asset/link URLs are absolute.

type OutreachEmailProps = {
  /** Plain text. A blank line starts a paragraph, a single newline breaks a
   * line. */
  body: string;
  unsubscribeUrl: string;
};

function paragraphs(body: string): string[] {
  return body
    .split(/\n\s*\n/)
    .map((block) => block.trim())
    .filter((block) => block.length > 0);
}

export default function OutreachEmail({ body, unsubscribeUrl }: OutreachEmailProps) {
  const blocks = paragraphs(body);
  return (
    <Html>
      <Head />
      <Preview>{blocks[0] ?? ""}</Preview>
      <Tailwind config={{ presets: [pixelBasedPreset] }}>
        <Body className="bg-white font-sans text-[#0F0E0D]">
          <Container className="mx-auto max-w-[520px] px-6 py-12">
            <DonkeyMark />
            {blocks.map((block, index) => (
              <Text key={index} className="text-[15px] leading-relaxed">
                {block.split("\n").map((line, lineIndex) => (
                  <Fragment key={lineIndex}>
                    {lineIndex > 0 ? <br /> : null}
                    {line}
                  </Fragment>
                ))}
              </Text>
            ))}
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

OutreachEmail.PreviewProps = {
  body: `Hey Ada,

I'm David — I build Donkey Cut. I saw you've been using the AI features.

What are you making?

Thanks,
David`,
  unsubscribeUrl: "https://donkeycut.com/unsubscribe?token=preview",
} satisfies OutreachEmailProps;
