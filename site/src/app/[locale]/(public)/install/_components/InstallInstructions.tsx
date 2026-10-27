import type { CSSProperties } from "react";
import Image from "next/image";
import { getTranslations } from "next-intl/server";

import {
  Headline,
  PillButton,
} from "@/app/_components/landing/LandingPrimitives";
import { DONKEY_DOWNLOAD_URL } from "@/app/_components/landing/data";

type InstallStep = {
  body: string;
  eyebrow: string;
  imageAlt: string;
  imageSrc: string;
  title: string;
};

// The three steps in order, each keyed into the `install.steps` catalog.
const installSteps = [
  { key: "open", imageSrc: "/install/install-open.png" },
  { key: "install", imageSrc: "/install/install-drag.png" },
  { key: "launch", imageSrc: "/install/install-launch.png" },
] as const;

export async function InstallInstructions() {
  const t = await getTranslations("install");
  const steps: InstallStep[] = installSteps.map((step, index) => ({
    body: t(`steps.${step.key}.body`),
    eyebrow: t("step", { number: index + 1 }),
    imageAlt: t(`steps.${step.key}.imageAlt`),
    imageSrc: step.imageSrc,
    title: t(`steps.${step.key}.title`),
  }));

  return (
    <section className="bg-background px-[clamp(20px,4vw,48px)] pt-[clamp(44px,7vw,88px)] pb-[clamp(80px,9vw,128px)] text-foreground">
      <div style={{ margin: "0 auto", maxWidth: 1280 }}>
        <Headline>
          {t.rich("title", {
            br: () => <br />,
            italic: (chunks) => <span style={{ fontStyle: "italic" }}>{chunks}</span>,
          })}
        </Headline>
        <p
          className="text-foreground/70"
          style={{
            fontSize: "clamp(16px, 1.8vw, 18px)",
            lineHeight: 1.6,
            margin: "24px 0 32px",
            maxWidth: 640,
          }}
        >
          {t("body")}
        </p>
        <PillButton href={DONKEY_DOWNLOAD_URL} variant="primary" size="lg">
          {t("download")}
        </PillButton>

        <div style={instructionPanelStyle}>
          <div style={stepsGridStyle}>
            {steps.map((step) => (
              <InstallStepCard key={step.title} step={step} />
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}

type InstallStepCardProps = {
  step: InstallStep;
};

function InstallStepCard({ step }: InstallStepCardProps) {
  return (
    <article style={stepCardStyle}>
      <div className="backlight-image" style={stepImageFrameStyle}>
        <Image
          alt={step.imageAlt}
          height={413}
          loading="eager"
          src={step.imageSrc}
          style={{
            display: "block",
            height: "auto",
            width: "100%",
          }}
          unoptimized
          width={617}
        />
      </div>
      <div style={stepCopyStyle}>
        <div
          style={{
            color: "#96928c",
            fontSize: 15,
            fontWeight: 600,
            lineHeight: 1.2,
            marginBottom: 18,
          }}
        >
          {step.eyebrow}
        </div>
        <h4
          style={{
            color: "#fff",
            fontSize: "clamp(28px, 3vw, 36px)",
            fontWeight: 600,
            lineHeight: 1,
            margin: "0 0 17px",
          }}
        >
          {step.title}
        </h4>
        <p
          style={{
            color: "#e5e2dd",
            fontSize: "clamp(16px, 1.9vw, 19px)",
            lineHeight: 1.36,
            margin: 0,
          }}
        >
          {step.body}
        </p>
      </div>
    </article>
  );
}

const instructionPanelStyle: CSSProperties = {
  background: "#1d1d1b",
  border: "1px solid rgba(255,255,255,0.13)",
  borderRadius: 24,
  boxShadow: "0 24px 70px rgba(0,0,0,0.18)",
  boxSizing: "border-box",
  marginTop: 54,
  minWidth: 0,
  overflow: "hidden",
  padding: "clamp(28px, 4.2vw, 48px)",
  position: "relative",
};

const stepsGridStyle: CSSProperties = {
  alignItems: "stretch",
  display: "grid",
  gap: "clamp(22px, 3vw, 36px)",
  gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 280px), 1fr))",
};

const stepCardStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  height: "100%",
  minWidth: 0,
};

const stepImageFrameStyle: CSSProperties = {
  aspectRatio: "617 / 413",
  flexShrink: 0,
  minWidth: 0,
  overflow: "hidden",
};

const stepCopyStyle: CSSProperties = {
  display: "flex",
  flex: 1,
  flexDirection: "column",
  minWidth: 0,
  padding: "clamp(24px, 3vw, 34px) clamp(8px, 1.4vw, 16px) 0",
};
