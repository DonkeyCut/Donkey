import { Fragment } from "react";
import { Body, Button, Head, Html, Link, Text } from "react-email";

type Props = {
  blocks: ({ kind: "text"; text: string } | { kind: "button" })[];
  cta: { label: string; url: string };
  unsubscribeUrl: string | null;
};

export default function OutreachEmail({ blocks, cta, unsubscribeUrl }: Props) {
  return (
    <Html>
      <Head />
      <Body style={{ fontFamily: "Arial, sans-serif", color: "#0F0E0D", backgroundColor: "#ffffff" }}>
        {blocks.map((block, index) => block.kind === "button" ? (
          <Button key={index} href={cta.url} style={{ backgroundColor: "#0F0E0D", color: "#ffffff", padding: "12px 24px", borderRadius: 8, fontSize: 15, fontWeight: 600 }}>
            {cta.label}
          </Button>
        ) : (
          <Text key={index} style={{ fontSize: 15, lineHeight: "24px", margin: "0 0 16px" }}>
            {block.text.split("\n").map((line, lineIndex) => (
              <Fragment key={lineIndex}>{lineIndex > 0 ? <br /> : null}{line}</Fragment>
            ))}
          </Text>
        ))}
        {unsubscribeUrl ? (
          <Text style={{ marginTop: 24, fontSize: 12, color: "#666666" }}>
            <Link href={unsubscribeUrl} style={{ color: "#666666" }}>Unsubscribe from product emails</Link>
          </Text>
        ) : null}
      </Body>
    </Html>
  );
}
